var redis = require('redis');
var setting = require('../config/setting.js');
var redisClient = redis.createClient(setting.redis_port, setting.redis_server);

redisClient.on('error', function (err) {
    console.log('Error ' + err);
});

redisClient.on('connect', function () {
    console.log('Redis is ready');
});

exports.redis = redis;
exports.redisClient = redisClient;
