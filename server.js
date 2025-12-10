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
  const { stpid, mapid, walkTime } = request.query;
  const ignoreMinutes = walkTime || -1;

  // Decide which type we're working with
  let ids;
  let idType;

  if (stpid) {
    ids = Array.isArray(stpid) ? stpid : stpid.split(','); // <--- split here
    idType = "stpid";
  } else if (mapid) {
    ids = Array.isArray(mapid) ? mapid : mapid.split(',');
    idType = "mapid";
  } else {
    return reply.status(400).send({ error: "Either stpid or mapid query parameter is required" });
  }


  const now = Date.now();

  // Create a cache key based on the idType and ids
  const cacheKey = `${idType}-${ids.join(',')}`;

  // Check if we have cached data for this key and it hasn't expired
  if (cache[cacheKey] && now - cache[cacheKey].lastFetchTime < CACHE_DURATION) {
    return reply.send(cache[cacheKey].data);
  }

  try {
    let results = [];

    const batchSize = 4;
    const batches = [];

    for (let i = 0; i < ids.length; i += batchSize) {
      const batch = ids.slice(i, i + batchSize);
      const batchQuery = batch.map(id => `${idType}=${id}`).join('&');
      const apiUrl = `https://lapi.transitchicago.com/api/1.0/ttarrivals.aspx?key=${process.env.TRAIN_API_KEY}&${batchQuery}&outputType=JSON&max=500`;
      batches.push(fetch(apiUrl).then(res => res.json()));
    }

    const allData = await Promise.all(batches);

    allData.forEach(data => {
      if (data.ctatt && data.ctatt.eta) {
        results = results.concat(data.ctatt.eta);
      }
    });


    // Process the combined results
    const groupedData = groupByRouteAndDirection(results, ignoreMinutes);

    // Cache it
    cache[cacheKey] = {
      data: groupedData,
      lastFetchTime: now,
    };

    const holidayTrainRunNumber = 1225
    const apiUrlFollow = `https://lapi.transitchicago.com/api/1.0/ttfollow.aspx?key=${process.env.TRAIN_API_KEY}&outputType=JSON&runnumber=${holidayTrainRunNumber}`;
    holidayTrainCheck = await (fetch(apiUrlFollow).then(res => res.json()))

    if (holidayTrainCheck.ctatt.errNm == null)
      routeNameMap = {
        G: 'Green',
        Brn: 'Brown',
        Org: 'Orange',
        P: 'Purple',
        Y: 'Yellow',
      };
      firstEta = holidayTrainCheck["ctatt"]["eta"][0]
      arrivalDate = new Date(firstEta.arrT);
      predictionDate = new Date(firstEta.prdt);
      diffInMinutes = Math.floor((arrivalDate - predictionDate) / (1000 * 60));
      routeName = routeNameMap[firstEta.rt] || firstEta.rt
      routeNameHoliday = "Holiday Train on " + routeName
      holidayTrainItem = {
        route: routeNameHoliday,
        routeNameFull: routeNameHoliday,
        stationName: firstEta.staNm,
        stopDescription: firstEta.stpDe,
        arrivalTime: diffInMinutes,
        routeNumber: firstEta.rn,
        destination: "To " + firstEta.destNm,
        isScheduled: firstEta.isSch,
        isArriving: firstEta.isApp,
        isDelayed: firstEta.isDly,
        isHoliday: true,
        isPride: false,
      }
      groupedData.unshift(holidayTrainItem);

    return reply.send(groupedData);

  } catch (error) {
    console.error('Error fetching arrivals:', error);
    return reply.status(500).send({ error: 'Failed to fetch data from CTA API', details: error.message });
  }
});


function groupByRouteAndDirection(eta, ignoreItems) {
  const routeNameMap = {
    G: 'Green',
    Brn: 'Brown',
    Org: 'Orange',
    P: 'Purple',
    Y: 'Yellow',
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

