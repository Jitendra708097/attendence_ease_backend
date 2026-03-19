const express = require("express");
const multer = require("multer");
const {registerFace, searchFaceMatch, startLivenessSession, fetchLivenessResult} = require("../controllers/face.controller.js");

const router = express.Router();

// Multer - store in memory (no disk storage)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max
  fileFilter: (req, file, cb) => {
    const allowed = ["image/jpeg", "image/jpg", "image/png"];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Only JPEG/PNG images allowed!"));
    }
  },
});

// Routes
router.post("/register", upload.single("image"), registerFace);
router.post("/search",   upload.single("image"), searchFaceMatch);
router.post("/liveness/create-session", startLivenessSession);
router.get("/liveness/result/:sessionId", fetchLivenessResult);

module.exports = router;