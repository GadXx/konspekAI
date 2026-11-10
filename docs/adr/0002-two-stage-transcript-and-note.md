# ADR 0002: Separate transcript normalization from note generation

- Status: accepted
- Date: 2026-11-11

## Context

Vosk returns a useful speech transcript but does not produce the polished sentence structure needed for a readable note. Combining transcript repair and summarization in one prompt makes it harder to inspect or reason about either result.

## Decision

After local Vosk transcription, a language-model pass restores punctuation and sentence boundaries while preserving content. A second logical pass creates a note from the normalized transcript. Both passes may make multiple calls when the configured context limit requires chunking. Intermediate text is retained for the configured job lifetime and returned only in development mode.

## Consequences

- The text-input path uses the same normalization and summary stages, skipping speech recognition.
- Long transcripts may require additional language-model calls.
- The final production response contains only the structured note.
