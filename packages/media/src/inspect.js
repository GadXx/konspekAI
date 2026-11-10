import { spawn } from 'node:child_process';
import { extname } from 'node:path';

const DEMUXERS = Object.freeze({
  '.wav': 'wav', '.mp3': 'mp3', '.m4a': 'mov', '.aac': 'aac', '.ogg': 'ogg',
  '.opus': 'ogg', '.flac': 'flac', '.wma': 'asf', '.mp4': 'mov', '.mkv': 'matroska',
  '.mov': 'mov', '.webm': 'matroska', '.avi': 'avi', '.m4v': 'mov',
});

export function mediaDemuxerForPath(filePath) {
  return DEMUXERS[extname(filePath).toLowerCase()];
}

export function getMediaDuration(filePath, ffmpegPath = 'ffmpeg', timeoutMs = 30000) {
  const ffprobePath = ffmpegPath.replace(/ffmpeg(?:\.exe)?$/, 'ffprobe');
  const demuxer = mediaDemuxerForPath(filePath);
  if (!demuxer) {return Promise.reject(new Error('Unsupported media file extension'));}
  return new Promise((resolve, reject) => {
    const probe = spawn(ffprobePath, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-f', demuxer, '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let errorOutput = '';
    let settled = false;
    const finish = (error, duration) => {
      if (settled) {return;}
      settled = true;
      clearTimeout(timer);
      if (error) {reject(error);} else {resolve(duration);}
    };
    const timer = setTimeout(() => {
      probe.kill('SIGKILL');
      finish(Object.assign(new Error('Media metadata inspection timed out'), { code: 'MEDIA_PROCESS_TIMEOUT' }));
    }, timeoutMs);
    probe.stdout.on('data', (chunk) => {
      output += chunk.toString();
      if (output.length > 4096) {
        probe.kill('SIGKILL');
        finish(new Error('Media metadata output exceeded the allowed size'));
      }
    });
    probe.stderr.on('data', (chunk) => { errorOutput = `${errorOutput}${chunk.toString()}`.slice(-2048); });
    probe.on('error', (error) => finish(new Error(`Could not start ffprobe: ${error.message}`)));
    probe.on('close', (code) => {
      if (settled) {return;}
      if (code !== 0) {
        finish(new Error(`Unable to read media duration: ${errorOutput.trim() || `ffprobe exited with code ${code}`}`));
        return;
      }
      const duration = Number(output.trim());
      if (!Number.isFinite(duration) || duration < 0) {
        finish(new Error('Media duration is missing or invalid'));
        return;
      }
      finish(undefined, duration);
    });
  });
}
