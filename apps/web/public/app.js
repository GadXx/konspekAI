const form = document.querySelector('#note-form');
const mediaInput = document.querySelector('#media-file');
const sourceText = document.querySelector('#source-text');
const submitButton = document.querySelector('#submit-button');
const views = {
  empty: document.querySelector('#empty-state'),
  progress: document.querySelector('#progress-state'),
  error: document.querySelector('#error-state'),
  note: document.querySelector('#note'),
};
let currentNote;

function showView(name) {
  for (const [key, element] of Object.entries(views)) {
    element.hidden = key !== name;
  }
}

function authHeaders() {
  const token = document.querySelector('#api-token').value.trim();
  return token ? { authorization: `Bearer ${token}` } : {};
}

function errorText(payload, status) {
  const code = payload?.error?.code;
  const messages = {
    UNAUTHORIZED: 'Для этого сервера нужен API-токен. Откройте «Настройки доступа» и укажите его.',
    UNSUPPORTED_LANGUAGE: 'Для выбранного языка речи на сервере нет установленной модели распознавания.',
    UPLOAD_TOO_LARGE: 'Файл слишком большой для загрузки.',
    MEDIA_TOO_LONG: 'Запись длиннее допустимого лимита сервера.',
    SUMMARY_QUALITY_FAILED: 'Модель не смогла подготовить связный конспект. Попробуйте ещё раз или выберите другой формат.',
    NO_SPEECH_DETECTED: 'В записи не удалось обнаружить речь.',
    INVALID_MEDIA_FILE: 'Не удалось прочитать медиафайл. Проверьте формат и целостность файла.',
  };
  return messages[code] ?? payload?.error?.message ?? payload?.message ?? `Ошибка запроса (${status}). Попробуйте ещё раз.`;
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { ...authHeaders(), ...options.headers } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(errorText(payload, response.status));
  }
  return payload;
}

function setProgress(message, title = 'Готовим конспект') {
  document.querySelector('#progress-title').textContent = title;
  document.querySelector('#progress-message').textContent = message;
}

async function waitForJob(id) {
  const labels = {
    queued: ['Задание в очереди', 'Ждём свободный обработчик.'],
    transcribing: ['Распознаём речь', 'Извлекаем текст из записи.'],
    normalizing_transcript: ['Оформляем текст', 'Расставляем пунктуацию и границы предложений.'],
    creating_summary: ['Составляем конспект', 'Выделяем главное и собираем разделы.'],
  };
  while (true) {
    await new Promise((resolve) => window.setTimeout(resolve, 2000));
    const job = await requestJson(`/api/v1/jobs/${encodeURIComponent(id)}`);
    const [title, message] = labels[job.progress] ?? labels[job.status] ?? ['Готовим конспект', 'Обрабатываем материал.'];
    setProgress(message, title);
    if (job.status === 'failed') {
      throw new Error(errorText({ error: job.error }, 409));
    }
    if (job.status === 'completed') {
      return requestJson(`/api/v1/jobs/${encodeURIComponent(id)}/result`);
    }
  }
}

function addText(parent, tag, className, text) {
  const element = document.createElement(tag);
  if (className) {
    element.className = className;
  }
  element.textContent = text;
  parent.append(element);
  return element;
}

function renderNote(note) {
  currentNote = note;
  document.querySelector('#note-title').textContent = note.title || 'Конспект';
  const summary = document.querySelector('#note-summary');
  summary.textContent = note.summary || '';
  summary.hidden = !note.summary;

  const sections = document.querySelector('#note-sections');
  sections.replaceChildren();
  for (const section of note.sections ?? []) {
    const block = document.createElement('section');
    block.className = 'note-section';
    addText(block, 'h3', '', section.heading);
    addText(block, 'p', '', section.content);
    sections.append(block);
  }

  const points = document.querySelector('#note-points');
  points.replaceChildren();
  for (const point of note.key_points ?? []) {
    addText(points, 'li', '', point);
  }
  document.querySelector('#points-section').hidden = points.children.length === 0;
  showView('note');
}

mediaInput.addEventListener('change', () => {
  document.querySelector('#file-name').textContent = mediaInput.files[0]?.name ?? 'Выберите аудио- или видеофайл';
  if (mediaInput.files.length) {
    sourceText.value = '';
  }
});
sourceText.addEventListener('input', () => {
  if (sourceText.value.trim()) {
    mediaInput.value = '';
    document.querySelector('#file-name').textContent = 'Выберите аудио- или видеофайл';
  }
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const file = mediaInput.files[0];
  const text = sourceText.value.trim();
  if (!file && !text) {
    sourceText.focus();
    return;
  }

  submitButton.disabled = true;
  showView('progress');
  setProgress('Создаём задание.', 'Отправляем материал');
  try {
    let body;
    const headers = {};
    if (file) {
      body = new FormData();
      body.append('media', file);
      body.append('language', document.querySelector('#language').value);
      body.append('summary_type', document.querySelector('#summary-type').value);
      const summaryLanguage = document.querySelector('#summary-language').value.trim();
      if (summaryLanguage) {
        body.append('summary_language', summaryLanguage);
      }
    } else {
      headers['content-type'] = 'application/json';
      body = JSON.stringify({
        text,
        language: document.querySelector('#language').value,
        summary_type: document.querySelector('#summary-type').value,
        ...(document.querySelector('#summary-language').value.trim() && { summary_language: document.querySelector('#summary-language').value.trim() }),
      });
    }
    const created = await requestJson('/api/v1/jobs', { method: 'POST', headers, body });
    const note = await waitForJob(created.id);
    renderNote(note);
  } catch (error) {
    document.querySelector('#error-message').textContent = error.message || 'Неизвестная ошибка.';
    showView('error');
  } finally {
    submitButton.disabled = false;
  }
});

document.querySelector('#try-again').addEventListener('click', () => showView('empty'));
document.querySelector('#copy-note').addEventListener('click', async (event) => {
  if (!currentNote) {
    return;
  }
  await navigator.clipboard.writeText(currentNote.markdown ?? '');
  event.currentTarget.textContent = 'Скопировано';
  window.setTimeout(() => { event.currentTarget.textContent = 'Скопировать'; }, 1800);
});
document.querySelector('#download-note').addEventListener('click', () => {
  if (!currentNote) {
    return;
  }
  const file = new Blob([currentNote.markdown ?? ''], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${(currentNote.title || 'konspekt').replace(/[\\/:*?"<>|]/g, '-').slice(0, 80)}.md`;
  link.click();
  URL.revokeObjectURL(url);
});

requestJson('/api/v1/languages').then(({ languages }) => {
  const select = document.querySelector('#language');
  select.replaceChildren();
  for (const { code } of languages) {
    const option = document.createElement('option');
    option.value = code;
    option.textContent = code === 'ru' ? 'Русский' : code;
    select.append(option);
  }
}).catch(() => {});
