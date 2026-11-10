# Domain glossary

| Term | Meaning |
|---|---|
| Job | One asynchronous request to create a note from text, audio, or video. A job owns its processing status and final result. |
| Recognized text | Raw text produced by the speech recognition engine from uploaded audio/video. For text input, this is the submitted text. |
| Normalized transcript | Recognized text with punctuation, casing, and meaningful sentence boundaries restored by the language model. |
| Note | The final structured document containing a title, summary, sections, key points, and Markdown representation. |
| Summary type | The requested level and shape of the note: `detailed`, `brief`, or `bullet_points`. |
| Speech language | The language used to choose a configured Vosk model, supplied as `language`. |
| Summary language | The output language requested for the note, supplied as `summary_language`; defaults to the speech language. |
| Lease | A time-limited claim held by a worker while it processes a job. An expired lease allows another worker to retry the job. |
| Development result | A result that includes the recognized text and normalized transcript in addition to the final note. |
