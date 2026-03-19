const {indexFace, searchFace,  createLivenessSession,  getLivenessResult,} =  require("../service/face.service.js");

// POST /api/face/register
 const registerFace = async (req, res) => {
  try {
    const { userId } = req.body;

    if (!req.file) {
      return res.status(400).json({ error: "Image file is required" });
    }
    if (!userId) {
      return res.status(400).json({ error: "userId is required" });
    }

    const result = await indexFace(req.file.buffer, userId);
    return res.status(200).json(result);

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};

// POST /api/face/search
const searchFaceMatch = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Image file is required" });
    }

    const result = await searchFace(req.file.buffer);
    return res.status(200).json(result);

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};

// POST /api/face/liveness/create-session
const startLivenessSession = async (req, res) => {
  try {
    const result = await createLivenessSession();
    return res.status(200).json(result);

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};

// GET /api/face/liveness/result/:sessionId
 const fetchLivenessResult = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const result = await getLivenessResult(sessionId);
    return res.status(200).json(result);

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};

module.exports = {
  registerFace,
  searchFaceMatch,
  startLivenessSession,
  fetchLivenessResult,
};