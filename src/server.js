const express = require('express');
const cookies = require('cookie-parser');
const cors = require('cors');
require('dotenv').config();
const redisClient = require('./config/redis');
const faceRoutes = require('./routes/face.routes');


const app = express();


app.use(cookies());
app.use(express.json());
const allowedOrigins = [process.env.ADMIN_WEB_URL, process.env.SUPERADMIN_WEB_URL];
app.use(cors({
    origin: function (origin, callback) {
        // allow requests with no origin (like mobile apps or curl requests)
        if (!origin) return callback(null, true);
        if (allowedOrigins.indexOf(origin) === -1) {
            const msg = 'The CORS policy for this site does not allow access from the specified Origin.';
            return callback(new Error(msg), false);
        }
        return callback(null, true);
    },
    credentials: true,
}));



app.use('/api/face', faceRoutes);


const startServer = () => {

    redisClient.connect()
    console.log('Connected to Redis');

  app.listen(process.env.PORT, () => {
    console.log(`Server is running on port ${process.env.PORT}`);
  });
}

startServer();