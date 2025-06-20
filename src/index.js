import express from 'express';
const app = express();
const  PORT = process.env.PORT ||5000
import marks from '../routes/marksheetRoute.js';

// Middleware to parse JSON bodies
app.use(express.json());

// Use the marks route
// app.use('api/marksheet', marks);

app.use('/api/marks', marks);




app.listen(PORT, () => {  console.log(`Server is running on port ${PORT}`);
});