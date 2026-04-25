const tf = require('@tensorflow/tfjs');
const blazeface = require('@tensorflow-models/blazeface');
const mobilenet = require('@tensorflow-models/mobilenet');
const sharp = require('sharp');

let faceDetectorPromise;
let embeddingModelPromise;

async function getFaceDetector() {
  if (!faceDetectorPromise) {
    faceDetectorPromise = blazeface.load();
  }

  return faceDetectorPromise;
}

async function getEmbeddingModel() {
  if (!embeddingModelPromise) {
    embeddingModelPromise = mobilenet.load({
      version: 2,
      alpha: 1,
    });
  }

  return embeddingModelPromise;
}

function normalizeVector(values) {
  const magnitude = Math.sqrt(values.reduce((sum, value) => sum + (value * value), 0));

  if (!magnitude) {
    return values.map(() => 0);
  }

  return values.map((value) => value / magnitude);
}

function reduceEmbedding(vector, targetLength = 128) {
  const reduced = [];
  const bucketSize = vector.length / targetLength;

  for (let index = 0; index < targetLength; index += 1) {
    const start = Math.floor(index * bucketSize);
    const end = Math.max(start + 1, Math.floor((index + 1) * bucketSize));
    const bucket = vector.slice(start, end);
    const avg = bucket.reduce((sum, value) => sum + value, 0) / bucket.length;
    reduced.push(avg);
  }

  return normalizeVector(reduced);
}

async function loadImageTensor(buffer, maxDimension) {
  const metadata = await sharp(buffer).metadata();
  const resizeRatio = maxDimension / Math.max(metadata.width || maxDimension, metadata.height || maxDimension, 1);
  const resizedWidth = Math.max(1, Math.round((metadata.width || maxDimension) * resizeRatio));
  const resizedHeight = Math.max(1, Math.round((metadata.height || maxDimension) * resizeRatio));
  const { data, info } = await sharp(buffer)
    .resize(resizedWidth, resizedHeight, { fit: 'inside' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const tensor = tf.tensor3d(new Uint8Array(data), [info.height, info.width, info.channels], 'int32');

  return {
    tensor,
    originalWidth: metadata.width || info.width,
    originalHeight: metadata.height || info.height,
    resizedWidth: info.width,
    resizedHeight: info.height,
  };
}

async function detectPrimaryFace(buffer) {
  const detector = await getFaceDetector();
  const { tensor, originalWidth, originalHeight, resizedWidth, resizedHeight } = await loadImageTensor(buffer, 320);

  try {
    const predictions = await detector.estimateFaces(tensor, false);

    if (!Array.isArray(predictions) || predictions.length === 0) {
      return null;
    }

    const [bestFace] = predictions.sort((a, b) => {
      const areaA = (a.bottomRight[0] - a.topLeft[0]) * (a.bottomRight[1] - a.topLeft[1]);
      const areaB = (b.bottomRight[0] - b.topLeft[0]) * (b.bottomRight[1] - b.topLeft[1]);
      return areaB - areaA;
    });

    const scaleX = originalWidth / resizedWidth;
    const scaleY = originalHeight / resizedHeight;
    const top = bestFace.topLeft[1] * scaleY;
    const left = bestFace.topLeft[0] * scaleX;
    const width = (bestFace.bottomRight[0] - bestFace.topLeft[0]) * scaleX;
    const height = (bestFace.bottomRight[1] - bestFace.topLeft[1]) * scaleY;
    const marginX = width * 0.22;
    const marginY = height * 0.28;

    return {
      left: Math.max(0, Math.floor(left - marginX)),
      top: Math.max(0, Math.floor(top - marginY)),
      width: Math.min(originalWidth, Math.ceil(width + (marginX * 2))),
      height: Math.min(originalHeight, Math.ceil(height + (marginY * 2))),
    };
  } finally {
    tensor.dispose();
  }
}

async function createEmbeddingTensor(buffer) {
  const { data, info } = await sharp(buffer)
    .resize(224, 224, { fit: 'cover' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  return tf.tidy(() => {
    const imageTensor = tf.tensor3d(new Uint8Array(data), [info.height, info.width, info.channels], 'int32');
    return imageTensor.expandDims(0).toFloat().div(255);
  });
}

async function generateFaceEmbedding(buffer) {
  const detectorBox = await detectPrimaryFace(buffer);

  if (!detectorBox) {
    const error = new Error('No face detected in selfie');
    error.code = 'FACE_004';
    error.statusCode = 422;
    throw error;
  }

  const croppedFace = await sharp(buffer)
    .extract(detectorBox)
    .jpeg({ quality: 90 })
    .toBuffer();

  const model = await getEmbeddingModel();
  const faceTensor = await createEmbeddingTensor(croppedFace);

  try {
    const activation = model.infer(faceTensor, true);
    const values = Array.from(await activation.data());
    activation.dispose();

    return {
      embedding: reduceEmbedding(values, 128),
      faceBox: detectorBox,
    };
  } finally {
    faceTensor.dispose();
  }
}

module.exports = {
  generateFaceEmbedding,
};
