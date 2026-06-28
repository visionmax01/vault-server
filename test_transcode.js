const { transcodeToHLS } = require('./src/utils/transcoder');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

function createDummyVideo(outputPath) {
  return new Promise((resolve, reject) => {
    // Generates a 3-second black video with 2 distinct audio streams (using sine waves of different frequencies)
    // Stream 0: Video
    // Stream 1: Audio (440Hz tone, English)
    // Stream 2: Audio (880Hz tone, Spanish)
    const cmd = `ffmpeg -y -f lavfi -i testsrc=size=320x240:rate=25 -f lavfi -i sine=frequency=440:beep_factor=4 -f lavfi -i sine=frequency=880:beep_factor=4 -map 0:v -map 1:a -map 2:a -t 3 -c:v libx264 -c:a aac -metadata:s:a:0 language=eng -metadata:s:a:0 title="English Track" -metadata:s:a:1 language=spa -metadata:s:a:1 title="Spanish Track" "${outputPath}"`;
    console.log('[Test] Creating dummy multi-audio video:', cmd);
    exec(cmd, (err, stdout, stderr) => {
      if (err) {
        console.error('[Test] Failed to create dummy video:', stderr);
        reject(err);
      } else {
        console.log('[Test] Dummy video created.');
        resolve();
      }
    });
  });
}

async function run() {
  const dummyVideo = path.join(__dirname, 'dummy_test_video.mp4');
  const outDir = path.join(__dirname, 'temp_hls_test');
  
  try {
    await createDummyVideo(dummyVideo);
    
    console.log('[Test] Running transcodeToHLS...');
    await transcodeToHLS(dummyVideo, outDir);
    console.log('[Test] Transcoding SUCCEEDED!');
    
    const filesList = fs.readdirSync(outDir);
    console.log('[Test] Generated files in HLS directory:');
    filesList.forEach(file => {
      console.log(`- ${file}`);
    });
    
    // Read master.m3u8
    const masterPath = path.join(outDir, 'master.m3u8');
    if (fs.existsSync(masterPath)) {
      console.log('=== master.m3u8 ===');
      console.log(fs.readFileSync(masterPath, 'utf8'));
      console.log('==================');
    }
  } catch (err) {
    console.error('[Test] FAILED:', err);
  } finally {
    // Clean up
    if (fs.existsSync(dummyVideo)) fs.unlinkSync(dummyVideo);
    if (fs.existsSync(outDir)) fs.rmSync(outDir, { recursive: true, force: true });
    process.exit(0);
  }
}

run();
