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

- **Which episodes**: *new episodes only* (found after you switch it on), *the latest N episodes of each podcast* (a rolling window that also covers new releases, so older back catalogue is left alone), or *all episodes, including the whole back catalogue*.
- **Which podcasts**: all podcasts, or only the ones you select. Only podcasts someone subscribes to are considered.

A large back catalogue is fed into the queue a few jobs at a time, newest first, so manual requests are never stuck behind hundreds of jobs. An episode that already has a job is not queued again; use **Retry** on the Jobs page for failures. These jobs show **Auto-transcribe** as the requester.

## Searching transcripts

Search across everything you follow from the **Search transcripts** page. It is a full-text search with its own index, so it stays fast as the library grows. A podcast nobody on the account follows is never searched, and you only see podcasts you subscribe to. See [Using the player](/guides/player).

What you can type:

| | |
|---|---|
| `tomatoes compost` | episodes that have every word somewhere, best matches first. Lines that hold all the words are shown, and rank higher |
| `"slow fermentation"` | the words next to each other, in order (also across two lines of the transcript) |
| `tomatoes -blight` | leave out episodes that have the word (or `-"a phrase"`) |
| `ferment` | other forms of the word (`fermentation`, `fermented`), and the beginning of the last word as you type it |
| `tomaato` | a word that is a letter or two off (five letters or more) |

Common small words (`the`, `and`, `of`) are not indexed, so they do not count as search words, but they still match inside a quoted phrase. Words are reduced to their stem with the Porter stemmer, which is for English: other languages match on the exact word (accents and case are ignored).

Results are ranked with BM25: a word that is rare in your library counts for more than a common one, and an episode that mentions the words often (compared with its length) ranks above one that mentions them once. The matching words are highlighted in each line.

The index is kept in memory. It is built in the background a few seconds after the server starts (about 3 seconds for 450 hours of transcripts, on a laptop) and updated as transcripts are added and removed. It holds the words of each line and where they are, not the text, so it adds about 17 MB per 100 hours of transcripts on top of the transcripts themselves. Searching before it has finished building simply finishes the build first.

## In the player

The transcript view highlights the current line (it looks about 1.5 s ahead to compensate for late Whisper timestamps), lets you tap a line to seek, search within the episode and bookmark a line. Transcripts are cached on your device for offline reading.
