'use strict';
importScripts('engine.js', 'model-ii.js', 'study.js');

self.onmessage = async ({ data }) => {
  const { job, config, options } = data;
  const onProgress = progress => postMessage({ progress });
  try {
    let result;
    if (job === 'replay') {
      result = options.weights.map(weights => Scudem.simulate({ ...config, weights }));
    } else if (job === 'distance') {
      result = await ScudemII.calibration(config, { ...options, onProgress });
    } else if (job === 'study') {
      result = ScudemStudy.run(config, { ...options, onProgress });
    } else {
      throw Error('Unknown calculation.');
    }
    postMessage({ result });
  } catch (error) {
    postMessage({ error: error.message });
  }
};
