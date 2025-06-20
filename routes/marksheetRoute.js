import express from 'express';

const router = express.Router();

const marks = [{
    id: 1,
    subject: 'Mathematics',
    score: 95
}, {
    id: 2,
    subject: 'Science',
    score: 88   
}];

/*
|
| get all marks from the database
| @route GET /marks
| @access Public
*/
router.get('/', (req, res) => {
    res.status(200).json({
        message: 'Get all marks',
        data: marks // This should be replaced with actual data from the database
    });
});

/*
|
| stores marks to the database
| @route POST /marks
| @access Public
*/
router.post('/marks', (req, res) => {
    // Implement storing marks logic here
    res.status(201).json({ message: 'Mark stored (not implemented)' });
});

export default router;