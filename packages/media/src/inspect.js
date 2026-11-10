import { spawn } from 'node:child_process';

export function getMediaDuration(filePath, ffmpegPath = 'ffmpeg') {
  const ffprobePath = ffmpegPath.replace(/ffmpeg(?:\.exe)?$/, 'ffprobe');
  return new Promise((resolve, reject) => {
    const probe = spawn(ffprobePath, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let errorOutput = '';
    probe.stdout.on('data', (chunk) => { output += chunk.toString(); });
    probe.stderr.on('data', (chunk) => { errorOutput += chunk.toString().slice(0, 1024); });
    probe.on('error', (error) => reject(new Error(`Could not start ffprobe: ${error.message}`)));
    probe.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Unable to read media duration: ${errorOutput.trim() || `ffprobe exited with code ${code}`}`));
        return;
      }
      const duration = Number(output.trim());
      if (!Number.isFinite(duration) || duration < 0) {
        reject(new Error('Media duration is missing or invalid'));
        return;
      }
      resolve(duration);
    });
  });
}
