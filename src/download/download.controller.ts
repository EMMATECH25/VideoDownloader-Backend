import { Controller, Get, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { exec } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as ffmpeg from 'fluent-ffmpeg';

// Define absolute paths for binaries
const BIN_PATH = path.join(__dirname, '..', '..', 'bin');
const YT_DLP_PATH = path.join(BIN_PATH, 'yt-dlp');
const FFMPEG_PATH = path.join(BIN_PATH, 'ffmpeg');
const FFPROBE_PATH = path.join(BIN_PATH, 'ffprobe');
const COOKIES_PATH = path.join(__dirname, '..', '..', 'cookies.txt');

ffmpeg.setFfmpegPath(FFMPEG_PATH);
ffmpeg.setFfprobePath(FFPROBE_PATH);

@Controller('download')
export class DownloadController {
  @Get()
  async downloadVideo(
    @Query('url') url: string,
    @Res() res: Response,
    @Query('start') start?: string,
    @Query('end') end?: string,
  ) {
    if (!url) {
      return res.status(400).json({ error: 'Please provide a video URL!' });
    }

    try {
      const outputPath = path.join(__dirname, '..', '..', 'downloads');
      if (!fs.existsSync(outputPath)) {
        fs.mkdirSync(outputPath, { recursive: true });
      }

      const originalVideoPath = path.join(outputPath, 'original_video.mp4');
      const processedVideoPath = path.join(outputPath, 'processed_video.mp4');

      console.log('Downloading video...');
      let ytDlpCommand = `${YT_DLP_PATH} -o "${originalVideoPath}" -f "bv*+ba/b" --merge-output-format mp4 --no-mtime --hls-prefer-ffmpeg "${url}"`;

      if (fs.existsSync(COOKIES_PATH)) {
        console.log('Using cookies file for authentication:', COOKIES_PATH);
        ytDlpCommand = `${YT_DLP_PATH} --cookies "${COOKIES_PATH}" -o "${originalVideoPath}" -f bestvideo+bestaudio/best --merge-output-format mp4 "${url}"`;
      } else {
        console.warn('Warning: cookies.txt not found, downloading may fail.');
      }

      console.log('Executing command:', ytDlpCommand);

      await new Promise<void>((resolve, reject) => {
        exec(ytDlpCommand, (error, stdout, stderr) => {
          if (error) {
            console.error('yt-dlp error:', error.message);
            reject(new Error('Download failed. Please try again.'));
            return; // Stop execution here
          }
          console.log(stdout || stderr);
          resolve();
        });
      }).catch((error: Error) => {
        console.error('Download process failed:', error.message);
      });

      if (!fs.existsSync(originalVideoPath)) {
        throw new Error('Download failed: File was not created.');
      }

      console.log('Download complete, ensuring correct format...');

      let ffmpegCommand = ffmpeg(originalVideoPath).outputOptions([
        '-y',
        '-c:v libx264',
        '-preset ultrafast',
        '-crf 30',
        '-c:a aac',
        '-b:a 128k',
        '-movflags +faststart', // Ensures MP4 compatibility
      ]);

      let finalVideoPath = processedVideoPath;

      const startTime = start ? parseFloat(start) : null;
      const endTime = end ? parseFloat(end) : null;

      if (startTime !== null && isNaN(startTime)) {
        return res.status(400).json({ error: 'Invalid start time provided.' });
      }
      if (endTime !== null && isNaN(endTime)) {
        return res.status(400).json({ error: 'Invalid end time provided.' });
      }
      if (startTime !== null && endTime !== null && startTime >= endTime) {
        return res
          .status(400)
          .json({ error: 'Start time must be less than end time.' });
      }

      if (startTime !== null || endTime !== null) {
        finalVideoPath = path.join(outputPath, 'trimmed_video.mp4');
        if (startTime !== null) {
          console.log(`Trimming from ${startTime}s`);
          ffmpegCommand = ffmpegCommand.inputOptions(`-ss ${startTime}`);
        }
        if (endTime !== null) {
          console.log(`Trimming to ${endTime}s`);
          ffmpegCommand = ffmpegCommand.inputOptions(`-to ${endTime}`);
        }
      }

      await new Promise<void>((resolve, reject) => {
        ffmpegCommand
          .output(finalVideoPath)
          .on('start', (cmd) => console.log('FFmpeg command:', cmd))
          .on('progress', (progress) => console.log('Progress:', progress))
          .on('end', () => {
            console.log('Processing complete.');
            resolve();
          })
          .on('error', (err: Error) => {
            console.error('Processing error:', err.message);
            reject(err);
          })
          .run();
      });

      console.log('Sending processed video...');
      res.download(finalVideoPath, 'downloaded_video.mp4', (err) => {
        if (err) {
          console.error('Download error:', err);

          // Only log the error instead of sending another response
          return;
        }

        // Cleanup files after the response is successfully sent
        setTimeout(() => {
          try {
            if (fs.existsSync(originalVideoPath))
              fs.unlinkSync(originalVideoPath);
            if (fs.existsSync(finalVideoPath)) fs.unlinkSync(finalVideoPath);
          } catch (cleanupError) {
            console.error('Error during file cleanup:', cleanupError);
          }
        }, 5000);
      });
    } catch (error: unknown) {
      console.error('Error:', error instanceof Error ? error.message : error);
      return res
        .status(500)
        .json({ error: 'Failed to download and process video' });
    }
  }
}
