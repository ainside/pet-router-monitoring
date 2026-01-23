const winston = require('winston');
const path = require('path');
require('dotenv').config(); // Ensure env vars are loaded

const logFormat = winston.format.printf(({ level, message, timestamp, ...metadata }) => {
    return `${timestamp} [${level}] : ${message}`;
});

const logLevel = process.env.LOG_LEVEL || 'info';

const logger = winston.createLogger({
    level: logLevel,
    format: winston.format.combine(
        winston.format.timestamp({
            format: 'YYYY-MM-DD HH:mm:ss'
        }),
        winston.format.errors({ stack: true }),
        winston.format.splat(),
        logFormat
    ),
    defaultMeta: { service: 'keenetic-service' },
    transports: [
        new winston.transports.File({ filename: path.join('logs', 'error.log'), level: 'error' }),
        new winston.transports.File({ filename: path.join('logs', 'info.log'), level: 'info' }),
        new winston.transports.File({ filename: path.join('logs', 'debug.log'), level: 'debug' }),
    ],
});

//
// If we're not in production then log to the `console` with the format:
// `${info.level}: ${info.message} JSON.stringify({ ...rest }) `
//
if (process.env.NODE_ENV !== 'production') {
    logger.add(new winston.transports.Console({
        level: logLevel, // Ensure console also respects the log level
        format: winston.format.combine(
            winston.format.colorize(),
            winston.format.simple(),
            logFormat
        ),
    }));
}

module.exports = logger;
