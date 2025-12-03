# CTA Train Arrivals Server and Visual Display

A Node.js backend that retrieves Chicago Transit Authority train arrival predictions and serves them through a Fastify API. The project also renders a Handlebars view and caches API results to improve performance.

## Table of Contents

- [Features](#features)  
- [Requirements](#requirements)  
- [Installation](#installation)  
- [Running the Server](#running-the-server)  
- [Endpoints](#endpoints)  
- [Response Format](#response-format)  
- [Project Structure](#project-structure)  
- [Developer Notes](#developer-notes)

## Features

- Fastify server with static file hosting  
- Handlebars view rendering  
- CTA API batching for stop or map ID lookups  
- Sixty second in memory cache  
- Walk time filtering  
- Sorted and cleaned arrival results

## Requirements

- Node.js 18 or newer  
- CTA Train Tracker API key  
- A `.env` file in the project root with:

```env
TRAIN_API_KEY=your_api_key
PORT=3000
```

## Installation
```
git clone <repo>
cd <project>
npm install
```

## Running the Server
```
npm start
```
Or run directly:
```
node server.js
```
The server listens on the port defined in your environment variables. The default is 3000.

## Endpoints

### GET /

Renders the main Handlebars view located at `src/pages/index.hbs`.

---

### GET /api/cta-arrivals

Fetches arrival predictions for one or more CTA stops. Is called from the main view located at `src/pages/index.hbs`.

**Query Parameters**
Query Parameters provided to the main page at / will return a GUI, Query Parameters provided to the API will return the raw data.

| Name       | Required | Description                                           |
|------------|----------|-------------------------------------------------------|
| `stpid`    | required* | One or more CTA stop IDs in comma separated format. Use this or `mapid`.       |
| `mapid`    | required* | One or more CTA map IDs in comma separated format. Use this or `stpid`.        |
| `walkTime` | optional | Ignore arrivals sooner than this many minutes.       |

**Example Requests**

```text
/api/cta-arrivals?stpid=32122
/?mapid=40340,40360
/?stpid=32112&walkTime=6
```

Notes
- Requests are grouped into batches of four to limit CTA API calls.
- Each unique combination of IDs gets its own cache entry.
- Cache entries are valid for 60 seconds.

## Response Format

Each arrival item returned by the `/api/cta-arrivals` endpoint includes the following fields:

```json
{
  "route": "Brown",
  "stationName": "Merchandise Mart",
  "stopDescription": "Platform 1",
  "arrivalTime": 4,
  "routeNumber": "423",
  "destination": "Kimball",
  "isScheduled": false,
  "isArriving": false,
  "isDelayed": false,
  "isHoliday": false,
  "isPride": false
}
```

### Field Descriptions

- **route**: Human-readable train line name (e.g., Brown, Green, Orange).  
- **stationName**: Name of the station where the train is arriving.  
- **stopDescription**: Description of the specific stop or platform.  
- **arrivalTime**: Minutes until the train arrives, calculated from prediction time.  
- **routeNumber**: Numeric route identifier for the train.  
- **destination**: Final destination of the train.  
- **isScheduled**: Boolean indicating whether the train is scheduled.  
- **isArriving**: Boolean indicating whether the train is actively arriving.  
- **isDelayed**: Boolean indicating whether the train is delayed.  
- **isHoliday**: Boolean indicating whether the train is a holiday-specific service (routes 1224 and 1225).
- **isPride**: Boolean indicating whether the train is a pride train service. **Future Planned Item***


## Project Structure

```text
/public # Static assets (CSS, JS, images)
/src/pages/index.hbs # Main Handlebars Template
server.js # Main server file
```

## Developer Notes

- **Handlebars Helper**: A `toJSON` helper is included for serializing objects inside templates.  
- **API Batching**: Requests to the CTA API are batched in groups of four to reduce load.  
- **Caching**: Arrival data is cached in memory for 60 seconds to avoid repeated API calls.  
- **Holiday Trains**: Routes 1224 and 1225 are flagged as holiday-specific trains.  
- **Data Processing**: Arrival data is filtered, grouped, and sorted by minutes until arrival before being returned.
