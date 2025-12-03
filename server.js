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

handlebars.registerHelper('toJSON', function(object){
  return new handlebars.SafeString(JSON.stringify(object));
});

fastify.register(require("@fastify/view"), {
  engine: {
    handlebars: handlebars,
  },
}); 

const fs = require('fs');
const prizes = JSON.parse(fs.readFileSync(path.join(__dirname, 'src/prizes.json')));

fastify.get("/", async function (request, reply) {  
  // The Handlebars code will be able to access the parameter values and build them into the page
  return reply.view("/src/pages/index.hbs");
});

const CACHE_DURATION = 59 * 1000; // Cache for 60 seconds

fastify.get('/api/cta-arrivals', async (request, reply) => {
  const { stpid, mapid, walkTime } = request.query;
  const ignoreMinutes = walkTime || -1;

  // Decide which type we're working with
  let ids = null;
  let idType = null;

  if (stpid) {
    ids = Array.isArray(stpid) ? stpid : [stpid];
    idType = 'stpid';
  } else if (mapid) {
    ids = Array.isArray(mapid) ? mapid : [mapid];
    idType = 'mapid';
  } else {
    return reply.status(400).send({ error: 'Either stpid or mapid query parameter is required' });
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

    // Split into batches of 4
    const batchSize = 4;
    for (let i = 0; i < ids.length; i += batchSize) {
      const batch = ids.slice(i, i + batchSize);
      const batchQuery = batch.map(id => `${idType}=${id}`).join('&');
      console.log(batchQuery)

      const apiUrl = `https://lapi.transitchicago.com/api/1.0/ttarrivals.aspx?key=${process.env.TRAIN_API_KEY}&${batchQuery}&outputType=JSON&max=500`;
      console.log(apiUrl)
      const response = await fetch(apiUrl);
      if (!response.ok) throw new Error(`Failed to fetch data for batch starting with ${batch[0]}`);

      const data = await response.json();
      if (data.ctatt && data.ctatt.eta) {
        results = results.concat(data.ctatt.eta);
      }
    }

    // Process the combined results
    const groupedData = groupByRouteAndDirection(results, ignoreMinutes);

    // Cache it
    cache[cacheKey] = {
      data: groupedData,
      lastFetchTime: now,
    };

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
      const { rt, staNm, stpDe, arrT, prdt, rn, destNm, isSch, isApp, isDly } = item;
      const arrivalDate = new Date(arrT);
      const predictionDate = new Date(prdt);
      const diffInMinutes = Math.floor((arrivalDate - predictionDate) / (1000 * 60));
      if ( rn == 1224 || rn == 1225 )
        isHolidayTrain = true,
        console.log("found holiday train")
      else
        isHolidayTrain = false

      if (diffInMinutes < ignoreItems) return null;

      return {
        route: routeNameMap[rt] || rt,
        stationName: staNm,
        stopDescription: stpDe,
        arrivalTime: diffInMinutes,
        routeNumber: rn,
        destination: destNm,
        isScheduled: isSch,
        isArriving: isApp,
        isDelayed: isDly, 
        isHoliday: isHolidayTrain,
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

