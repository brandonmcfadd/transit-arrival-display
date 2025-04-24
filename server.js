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

const CACHE_DURATION = 60 * 1000; // Cache for 60 seconds

fastify.get('/api/cta-arrivals', async (request, reply) => {
  let stpids = request.query.stpid || 40380;
  const ignoreMinutes = request.query.walkTime || -1;

  // Ensure stpids is an array
  if (!Array.isArray(stpids)) {
    stpids = String(stpids).split(',').map(s => s.trim());
  }

  if (stpids.length === 0) {
    return reply.status(400).send({ error: 'At least one stpid is required' });
  }

  const now = Date.now();

  const CACHE_DURATION = 15 * 1000; // Example: 15 seconds
  const BATCH_SIZE = 4;

  let allArrivals = [];

  // Check which stpids can be served from cache
  const fetchTasks = [];

  for (let i = 0; i < stpids.length; i += BATCH_SIZE) {
    const batch = stpids.slice(i, i + BATCH_SIZE);

    // Check cache for each in the batch
    const uncachedStpids = batch.filter(stpid =>
      !cache[stpid] || now - cache[stpid].lastFetchTime >= CACHE_DURATION
    );

    if (uncachedStpids.length > 0) {
      const apiUrl = `https://lapi.transitchicago.com/api/1.0/ttarrivals.aspx?key=${process.env.TRAIN_API_KEY}&stpid=${uncachedStpids.join(',')}&outputType=JSON&max=500`;
      fetchTasks.push(fetch(apiUrl)
        .then(res => {
          if (!res.ok) throw new Error('Failed to fetch CTA data');
          return res.json();
        })
        .then(apiData => {
          const arrivals = groupByRouteAndDirection(apiData.ctatt.eta || [], ignoreMinutes);
          // Cache each stpid in the batch
          for (const id of uncachedStpids) {
            cache[id] = {
              data: arrivals,
              lastFetchTime: now,
            };
          }
          return arrivals;
        })
        .catch(err => {
          console.error(`Error fetching for stpids ${uncachedStpids.join(',')}:`, err.message);
          return [];
        }));
    }

    // Add cached data
    for (const id of batch) {
      if (cache[id] && now - cache[id].lastFetchTime < CACHE_DURATION) {
        allArrivals.push(...cache[id].data);
      }
    }
  }

  try {
    const newArrivals = await Promise.all(fetchTasks);
    newArrivals.forEach(arr => allArrivals.push(...arr));

    // Sort all arrivals by timestamp or arrivalTime if needed
    allArrivals.sort((a, b) => a.arrivalTime - b.arrivalTime);

    return reply.send(allArrivals);
  } catch (error) {
    return reply.status(500).send({ error: 'Failed to fetch some or all CTA data', details: error.message });
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
      const { rt, staNm, stpDe, arrT, rn, destNm, isSch, isApp, isDly } = item;
      const arrivalDate = new Date(arrT);
      const diffInMinutes = Math.floor((arrivalDate - currentTime) / (1000 * 60));

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

