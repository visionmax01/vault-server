const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

/**
 * Get available audio streams using ffprobe
 * @param {string} filePath - Absolute path to input video file
 * @returns {Promise<Array>} List of audio stream metadata objects
 */
const getAudioStreams = (filePath) => {
  return new Promise((resolve) => {
    const cmd = `ffprobe -v error -select_streams a -show_entries stream=index,codec_name:stream_tags=language,title -of json "${filePath}"`;
    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        console.error('[Transcoder] ffprobe error:', error);
        resolve([]);
        return;
      }
      try {
        const data = JSON.parse(stdout);
        resolve(data.streams || []);
      } catch (err) {
        console.error('[Transcoder] ffprobe parse error:', err);
        resolve([]);
      }
    });
  });
};

/**
 * Transcode video to HLS with multi-audio track support
 * @param {string} filePath - Absolute path to input video file
 * @param {string} outputDir - Directory where HLS segments and playlists will be written
 * @returns {Promise<void>} Resolves when transcoding is complete
 */
const transcodeToHLS = async (filePath, outputDir) => {
  const streams = await getAudioStreams(filePath);
  console.log(`[Transcoder] Found ${streams.length} audio stream(s) in video.`);

  let audioMaps = '';
  let varStreamMap = 'v:0,agroup:audio';

  if (streams.length > 0) {
    streams.forEach((stream, idx) => {
      audioMaps += ` -map 0:a:${idx}`;

      const lang = stream.tags?.language || 'eng';
      // Safe clean language tag (alphanumeric only)
      const cleanLang = lang.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();

      let title = stream.tags?.title || `Track_${idx + 1}`;
      // Safe title (alphanumeric and underscores only, no spaces or special chars for ffmpeg mapping)
      title = title.replace(/[^a-zA-Z0-9]/g, '_');

      const isDefault = idx === 0 ? 'YES' : 'NO';
      varStreamMap += ` a:${idx},agroup:audio,language:${cleanLang},title:${title},default:${isDefault}`;
    });
  } else {
    // Video only
    varStreamMap = 'v:0';
  }

  return new Promise((resolve, reject) => {
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const outputPattern = path.join(outputDir, 'stream_%v.m3u8');
    const cmd = `ffmpeg -y -i "${filePath}" -map 0:v:0 ${audioMaps} -c:v copy -c:a aac -hls_time 10 -hls_list_size 0 -master_pl_name master.m3u8 -var_stream_map "${varStreamMap}" "${outputPattern}"`;

    console.log('[Transcoder] Running command:', cmd);

    exec(cmd, { maxBuffer: 1024 * 1024 * 100 }, (error, stdout, stderr) => {
      if (error) {
        console.error('[Transcoder] ffmpeg error:', error);
        console.error('[Transcoder] ffmpeg stderr:', stderr);
        reject(error);
      } else {
        console.log('[Transcoder] Transcoding finished successfully.');
        resolve();
      }
    });
  });
};

module.exports = {
  getAudioStreams,
  transcodeToHLS
};
