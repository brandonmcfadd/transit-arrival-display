#!/usr/bin/env node
/**
 * This is the main Node.js server script for your project
 * Check out the two endpoints this back-end API provides in fastify.get and fastify.post below
 */

const path = require("path");

// Require the fastify framework and instantiate it
const fastify = require("fastify")({
  // Set this to true for detailed logging:
  logger: false,
});

fastify.register(require('@fastify/formbody'));

require('dotenv').config();

const storage = require('node-persist');
const cache = require('nano-cache');

// Setup our static files
fastify.register(require("@fastify/static"), {
  root: path.join(__dirname, "public"),
  prefix: "/", // optional: default '/'
});

// View is a templating manager for fastify
const handlebars = require('handlebars');

handlebars.registerHelper('toJSON', function (object) {
  return new handlebars.SafeString(JSON.stringify(object));
});

fastify.register(require("@fastify/view"), {
  engine: {
    handlebars: handlebars,
  },
});

const fs = require('fs');

fastify.get("/", async function (request, reply) {
  // The Handlebars code will be able to access the parameter values and build them into the page
  return reply.view("/src/pages/index.hbs");
});

const CACHE_DURATION = 59 * 1000; // Cache for 60 seconds

fastify.get('/api/cta-arrivals', async (request, reply) => {
  const query = request.query;
  const trainStpids = queryValues(query.trainStpid ?? query.stpid);
  const trainMapids = queryValues(query.trainMapid ?? query.mapid);
  const busStpids = queryValues(query.busStpid);
  const busRoutes = queryValues(query.busRt);
  const ignoreMinutesTrain = Number(query.trainWalkTime ?? query.walkTime ?? -1);
  const ignoreMinutesBus = Number(query.busWalkTime ?? -1);

  if ((!trainStpids.length && !trainMapids.length && !busStpids.length) ||
      (busRoutes.length && !busStpids.length)) {
    return reply.status(400).send({
      error: "Provide trainStpid, trainMapid, or busStpid; busRt requires busStpid",
    });
  }
  if (!Number.isFinite(ignoreMinutesTrain) || !Number.isFinite(ignoreMinutesBus)) {
    return reply.status(400).send({ error: "Walk times must be valid numbers" });
  }

  const trainIds = trainStpids.length ? trainStpids : trainMapids;
  const trainIdType = trainStpids.length ? "stpid" : "mapid";
  const cacheKey = JSON.stringify({
    trainIdType: trainIds.length ? trainIdType : null,
    trainIds,
    ignoreMinutesTrain,
    busStpids,
    busRoutes,
    ignoreMinutesBus,
  });
  const now = Date.now();
  if (cache[cacheKey] && now - cache[cacheKey].lastFetchTime < CACHE_DURATION) {
    return reply.send(cache[cacheKey].data);
  }

  const arrivals = [];
  const sourceErrors = [];
  let successfulSources = 0;

  if (trainIds.length) {
    try {
      const batches = [];
      for (let i = 0; i < trainIds.length; i += 4) {
        const url = new URL('https://lapi.transitchicago.com/api/1.0/ttarrivals.aspx');
        url.searchParams.set('key', process.env.TRAIN_API_KEY || '');
        url.searchParams.set('outputType', 'JSON');
        url.searchParams.set('max', '500');
        trainIds.slice(i, i + 4).forEach(id => url.searchParams.append(trainIdType, id));
        batches.push(fetch(url).then(async response => {
          if (!response.ok) throw new Error(`Train Tracker API returned HTTP ${response.status}`);
          return response.json();
        }));
      }
      const allData = await Promise.all(batches);
      const trainResults = allData.flatMap(data => {
        if (data.ctatt?.errCd && data.ctatt.errCd !== '0') {
          throw new Error(data.ctatt.errNm || `Train Tracker API error ${data.ctatt.errCd}`);
        }
        return data.ctatt?.eta || [];
      });

      arrivals.push(...groupByRouteAndDirection(trainResults, ignoreMinutesTrain));
      successfulSources += 1;

      try {
        const holidayTrainRunNumber = 1225;
        const holidayUrl = new URL('https://lapi.transitchicago.com/api/1.0/ttfollow.aspx');
        holidayUrl.searchParams.set('key', process.env.TRAIN_API_KEY || '');
        holidayUrl.searchParams.set('outputType', 'JSON');
        holidayUrl.searchParams.set('runnumber', String(holidayTrainRunNumber));
        const holidayResponse = await fetch(holidayUrl);
        if (!holidayResponse.ok) {
          throw new Error(`Train Tracker API returned HTTP ${holidayResponse.status}`);
        }
        const holidayData = await holidayResponse.json();
        const holidayEtas = holidayData.ctatt?.eta;
        if (holidayEtas?.length) {
          const firstEta = holidayEtas[0];
          const arrivalDate = new Date(firstEta.arrT);
          const predictionDate = new Date(firstEta.prdt);
          const routeNameMap = { G: 'Green', Brn: 'Brown', Org: 'Orange', P: 'Purple', Y: 'Yellow' };
          const routeName = routeNameMap[firstEta.rt] || firstEta.rt;
          const routeNameHoliday = `Holiday Train on ${routeName}`;
          arrivals.unshift({
            route: routeNameHoliday,
            routeNameFull: routeNameHoliday,
            stationName: firstEta.staNm,
            stopDescription: firstEta.stpDe,
            arrivalTime: Math.floor((arrivalDate - predictionDate) / 60000),
            routeNumber: firstEta.rn,
            destination: `To ${firstEta.destNm}`,
            isScheduled: firstEta.isSch,
            isArriving: firstEta.isApp,
            isDelayed: firstEta.isDly,
            isHoliday: true,
            isPride: false,
          });
        }
      } catch (error) {
        sourceErrors.push(`Holiday train estimate: ${error.message}`);
        console.error('Error fetching holiday train estimate:', error);
      }
    } catch (error) {
      sourceErrors.push(`Train arrivals: ${error.message}`);
      console.error('Error fetching train arrivals:', error);
    }
  }

  if (busStpids.length) {
    try {
      const url = new URL('https://www.ctabustracker.com/bustime/api/v2/getpredictions');
      url.searchParams.set('key', process.env.BUS_API_KEY || '');
      url.searchParams.set('format', 'json');
      url.searchParams.set('stpid', busStpids.join(','));
      if (busRoutes.length) url.searchParams.set('rt', busRoutes.join(','));

      const response = await fetch(url);
      if (!response.ok) throw new Error(`Bus Tracker API returned HTTP ${response.status}`);
      const data = await response.json();
      const busResponse = data['bustime-response'];
      if (busResponse?.error) {
        const errors = Array.isArray(busResponse.error) ? busResponse.error : [busResponse.error];
        throw new Error(errors.map(error => error.msg).join('; '));
      }

      const predictions = busResponse?.prd || [];
      for (const prediction of Array.isArray(predictions) ? predictions : [predictions]) {
        const isDue = prediction.prdctdn === 'DUE';
        const arrivalTime = isDue ? 0 : Number(prediction.prdctdn);
        if (!Number.isInteger(arrivalTime)) {
          throw new Error(`Invalid bus prediction countdown: ${prediction.prdctdn}`);
        }
        if (!Number.isFinite(arrivalTime) || arrivalTime < ignoreMinutesBus) continue;
        arrivals.push({
          route: 'Bus',
          routeNameFull: `Bus Route `,
          stationName: prediction.stpnm,
          stopDescription: prediction.rtdir,
          arrivalTime,
          routeNumber: `${prediction.rt}`,
          destination: prediction.des,
          isScheduled: '0',
          isArriving: isDue || arrivalTime <= 1,
          isDelayed: prediction.dly ? '1' : '0',
          isHoliday: false,
          isPride: false,
        });
      }
      successfulSources += 1;
    } catch (error) {
      sourceErrors.push(`Bus arrivals: ${error.message}`);
      console.error('Error fetching bus arrivals:', error);
    }
  }

  if (successfulSources === 0) {
    return reply.status(502).send({
      error: 'Failed to fetch arrivals from CTA Tracker APIs',
      details: sourceErrors,
    });
  }

  arrivals.sort((a, b) => a.arrivalTime - b.arrivalTime);
  if (sourceErrors.length) {
    reply.header('X-CTA-Source-Errors', encodeURIComponent(sourceErrors.join('; ')));
  } else {
    cache[cacheKey] = { data: arrivals, lastFetchTime: Date.now() };
  }
  return reply.send(arrivals);
});

function queryValues(value) {
  const values = Array.isArray(value) ? value : [value];
  return values
    .filter(item => typeof item === 'string')
    .flatMap(item => item.split(','))
    .map(item => item.trim())
    .filter(Boolean);
}

function groupByRouteAndDirection(eta, ignoreItems) {
  const routeNameMap = {
    G: 'Green',
    Brn: 'Brown',
    Org: 'Orange',
    P: 'Purple',
    Y: 'Yellow',
    Bus: 'Bus',
  };

  const currentTime = new Date();

  const filteredArrivals = eta
    .map((item) => {
      const { rt, staNm, stpDe, arrT, prdt, rn, destNm, isSch, isApp, isDly, flags } = item;
      const arrivalDate = new Date(arrT);
      const predictionDate = new Date(prdt);
      const diffInMinutes = Math.floor((arrivalDate - predictionDate) / (1000 * 60));
      const runFlags = toString(flags)
      if ((rn == 1224 || rn == 1225))
        isHolidayTrain = true,
        console.log("found holiday train")
      else
        isHolidayTrain = false

      if (rn != 1224 && rn != 1225 && runFlags.includes("H"))
        isPrideTrain = true,
        console.log("found pride train")
      else
        isPrideTrain = false

      if (diffInMinutes < ignoreItems) return null;

      routeName = routeNameMap[rt] || rt
      
      return {
        route: routeName,
        routeNameFull: routeName + " Line",
        stationName: staNm,
        stopDescription: stpDe,
        arrivalTime: diffInMinutes,
        routeNumber: rn,
        destination: destNm,
        isScheduled: isSch,
        isArriving: isApp,
        isDelayed: isDly,
        isHoliday: isHolidayTrain,
        isPride: isPrideTrain,
      };
    })
    .filter(Boolean) // remove nulls
    .sort((a, b) => a.arrivalTime - b.arrivalTime); // sort by minutes

  return filteredArrivals;
}

// Run the server and report out to the logs
fastify.listen(
  { port: Number(process.env.PORT ?? 3000), host: "0.0.0.0" },
  function (err, address) {
    if (err) {
      fastify.log.error(err);
      process.exit(1);
    }
    console.log(`Your app is listening on ${address}`);
    fastify.log.info(`server listening on ${address}`);
  }
);
