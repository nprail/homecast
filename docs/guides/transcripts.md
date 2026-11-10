---
title: "Transcripts"
description: "Publisher transcripts, Whisper, models and auto-transcribe."
---

# Transcripts

Any signed-in user can request a transcript from the player. Requests are **deduplicated per episode** and transcripts are **shared across users**, so each episode is processed at most once.

## Where transcripts come from

1. **Publisher transcript**: if the feed has `<podcast:transcript>` (WebVTT, SubRip or Podcasting 2.0 JSON), it is fetched and used immediately.
2. **Whisper**: otherwise the server runs [whisper.cpp](https://github.com/ggml-org/whisper.cpp) on the audio.

## The Whisper pipeline

The worker handles one job at a time (persisted in the database and resumed after a restart):

1. Download the audio to a temp directory (up to 1 GB, 60 s stall timeout).
2. Convert with `ffmpeg` to 16 kHz mono WAV.
3. Run `whisper-cli` and read its JSON output.
4. Store the segments `[{startMs, endMs, text}]` and delete the temp files.

Subprocesses are spawned with argument arrays (never a shell), with a timeout and in a temp directory.

## Models

The default is **`base.en-q5_1`**: about 60 MB and faster than real time on a modest CPU. Change it under **Admin → Settings**:

| Model | Notes |
|---|---|
| `base.en-q5_1` | default |
| `small.en-q5_1` | better accuracy, roughly 3× the compute |
| `base` | multilingual |

Models are looked up as `ggml-<name>.bin` in `WHISPER_MODEL_DIR`. If a standard model is missing, the server **downloads it from Hugging Face on first use** (the job shows *Downloading model …*). A custom file path must already exist.

## Auto-transcribe

Under **Admin → Settings → Auto-transcribe** the server can queue transcripts without anyone asking:

- **Which episodes**: *new episodes only* (found after you switch it on) or *all episodes, including the back catalogue*.
- **Which podcasts**: all podcasts, or only the ones you select. Only podcasts someone subscribes to are considered.

A large back catalogue is fed into the queue a few jobs at a time, newest first, so manual requests are never stuck behind hundreds of jobs. An episode that already has a job is not queued again; use **Retry** on the Jobs page for failures. These jobs show **Auto-transcribe** as the requester.

## In the player

The transcript view highlights the current line (it looks about 1.5 s ahead to compensate for late Whisper timestamps), lets you tap a line to seek, search within the episode and bookmark a line. Transcripts are cached on your device for offline reading.
