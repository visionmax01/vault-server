const express = require('express');
const router = express.Router();
const movieController = require('../controllers/movieController');
const authMiddleware = require('../middlewares/auth');

// @route   GET api/movies
// @desc    List all public movies
router.get('/', movieController.listMovies);

// @route   GET api/movies/search
// @desc    Search movies and series
router.get('/search', movieController.searchMovies);

// @route   GET api/movies/poster/:movieId
// @desc    Stream movie poster image
router.get('/poster/:movieId', movieController.streamPoster);

// @route   GET api/movies/stream/:movieId/:filename?
// @desc    Stream movie video content
router.get('/stream/:movieId/:filename?', authMiddleware, movieController.streamMovie);

module.exports = router;
