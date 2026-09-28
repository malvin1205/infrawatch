// Alarm ticker clock. Timers in a hidden page are throttled to once a minute
// after a few minutes, so the siren could start or stop up to a minute late
// in a background tab; a worker's timers are not throttled that way.
setInterval(() => postMessage(0), 1000);
