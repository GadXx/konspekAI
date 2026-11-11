<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

const route = useRoute();
const router = useRouter();
const view = computed(() => route.name === 'create' ? 'create' : 'library');
const apiToken = ref(sessionStorage.getItem('konspekai-api-token') ?? '');
const sourceText = ref('');
const sourceFile = ref(null);
const language = ref('ru');
const summaryLanguage = ref('');
const summaryType = ref('detailed');
const languages = ref([{ code: 'ru' }]);
const isSubmitting = ref(false);
const progressTitle = ref('Готовим конспект');
const progressMessage = ref('Это может занять несколько минут.');
const submitError = ref('');
const currentNote = ref(null);
const copied = ref(false);

const folders = ref([]);
const notes = ref([]);
const totalNotes = ref(0);
const allNotesCount = ref(0);
const unfiledNotesCount = ref(0);
const selectedFolder = ref('all');
const selectedNote = ref(null);
const noteCache = new Map();
const search = ref('');
const libraryLoading = ref(false);
const libraryError = ref('');
const folderName = ref('');
const renamingFolderId = ref(null);
const renamedFolder = ref('');
const folderBusy = ref(false);
const noteBusy = ref(false);
let searchTimer;

function authHeaders() {
  return apiToken.value.trim() ? { authorization: `Bearer ${apiToken.value.trim()}` } : {};
}

async function request(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { ...authHeaders(), ...options.headers } });
  if (response.status === 204) {
    return undefined;
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const messages = {
      UNAUTHORIZED: 'Для доступа к серверу введите API-токен в настройках.',
      SUMMARY_QUALITY_FAILED: 'Модель не смогла подготовить связный конспект. Попробуйте ещё раз.',
      UNSUPPORTED_LANGUAGE: 'Для выбранного языка речи нет установленной модели.',
      UPLOAD_TOO_LARGE: 'Файл превышает допустимый размер.',
      MEDIA_TOO_LONG: 'Запись длиннее допустимого ограничения сервера.',
      NO_SPEECH_DETECTED: 'В записи не удалось обнаружить речь.',
      INVALID_MEDIA_FILE: 'Не удалось прочитать файл. Проверьте формат и целостность записи.',
      FOLDER_NOT_FOUND: 'Эта папка больше не существует. Обновите библиотеку.',
      NOTE_NOT_FOUND: 'Этот конспект больше не существует. Обновите библиотеку.',
    };
    throw new Error(messages[payload?.error?.code] ?? payload?.error?.message ?? `Ошибка запроса (${response.status}).`);
  }
  return payload;
}

watch(apiToken, (value) => {
  if (value.trim()) {
    sessionStorage.setItem('konspekai-api-token', value.trim());
  } else {
    sessionStorage.removeItem('konspekai-api-token');
  }
});

async function loadLanguages() {
  try {
    const result = await request('/api/v1/languages');
    languages.value = result.languages;
    if (!languages.value.some((item) => item.code === language.value)) {
      language.value = languages.value[0]?.code ?? 'ru';
    }
  } catch {
    // The API keeps the configured Russian default when the language list is unavailable.
  }
}

function libraryQuery(offset = 0) {
  const params = new URLSearchParams({ limit: '100', offset: String(offset) });
  if (selectedFolder.value !== 'all') {
    params.set('folder_id', selectedFolder.value);
  }
  if (search.value.trim()) {
    params.set('q', search.value.trim());
  }
  return `/api/v1/library?${params}`;
}

async function loadLibrary({ keepSelection = false } = {}) {
  libraryLoading.value = true;
  libraryError.value = '';
  const previousId = keepSelection ? selectedNote.value?.id : null;
  try {
    const result = await request(libraryQuery());
    folders.value = result.folders;
    notes.value = result.notes;
    totalNotes.value = result.total;
    allNotesCount.value = result.all_count;
    unfiledNotesCount.value = result.unfiled_count;
    if (previousId && notes.value.some((note) => note.id === previousId)) {
      selectedNote.value = noteCache.get(previousId) ?? selectedNote.value;
    } else if (selectedNote.value && !notes.value.some((note) => note.id === selectedNote.value.id)) {
      selectedNote.value = null;
    }
  } catch (error) {
    libraryError.value = error.message;
  } finally {
    libraryLoading.value = false;
  }
}

async function loadMoreNotes() {
  if (libraryLoading.value || notes.value.length >= totalNotes.value) {
    return;
  }
  libraryLoading.value = true;
  try {
    const result = await request(libraryQuery(notes.value.length));
    notes.value.push(...result.notes);
  } catch (error) {
    libraryError.value = error.message;
  } finally {
    libraryLoading.value = false;
  }
}

async function openLibrary() {
  await router.push({ name: 'library', query: route.query });
}

async function selectFolder(folderId) {
  await router.push({ name: 'library', query: { ...route.query, folder: folderId === 'all' ? undefined : folderId } });
}

async function openNote(id) {
  await router.push({ name: 'library-note', params: { noteId: id }, query: route.query });
}

async function loadNote(id) {
  if (noteCache.has(id)) {
    selectedNote.value = noteCache.get(id);
    return;
  }
  try {
    const note = await request(`/api/v1/library/notes/${encodeURIComponent(id)}`);
    noteCache.set(id, note);
    selectedNote.value = note;
  } catch (error) {
    libraryError.value = error.message;
    selectedNote.value = null;
  }
}

function setProgress(progress, status) {
  const labels = {
    queued: ['Задание в очереди', 'Ждём свободный обработчик.'],
    transcribing: ['Распознаём речь', 'Извлекаем текст из записи.'],
    normalizing_transcript: ['Оформляем текст', 'Разбиваем речь на предложения и расставляем пунктуацию.'],
    creating_summary: ['Составляем конспект', 'Выделяем главное и собираем структуру.'],
  };
  [progressTitle.value, progressMessage.value] = labels[progress] ?? labels[status] ?? ['Готовим конспект', 'Обрабатываем материал.'];
}

function delay(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function waitForJob(id) {
  let pollDelay = 2500;
  while (true) {
    await delay(pollDelay);
    const job = await request(`/api/v1/jobs/${encodeURIComponent(id)}`);
    setProgress(job.progress, job.status);
    if (job.status === 'failed') {
      throw new Error(job.error?.message ?? 'Не удалось подготовить конспект.');
    }
    if (job.status === 'completed') {
      return request(`/api/v1/jobs/${encodeURIComponent(id)}/result`);
    }
    pollDelay = Math.min(pollDelay + 500, 6000);
  }
}

async function createNote() {
  if (!sourceFile.value && !sourceText.value.trim()) {
    submitError.value = 'Добавьте текст или выберите запись.';
    return;
  }
  submitError.value = '';
  isSubmitting.value = true;
  currentNote.value = null;
  await goCreate();
  progressTitle.value = 'Отправляем материал';
  progressMessage.value = 'Создаём задание.';
  try {
    let body;
    const headers = {};
    if (sourceFile.value) {
      body = new FormData();
      body.append('media', sourceFile.value);
      body.append('language', language.value);
      body.append('summary_type', summaryType.value);
      if (summaryLanguage.value.trim()) {
        body.append('summary_language', summaryLanguage.value.trim());
      }
    } else {
      headers['content-type'] = 'application/json';
      body = JSON.stringify({
        text: sourceText.value.trim(),
        language: language.value,
        summary_type: summaryType.value,
        ...(summaryLanguage.value.trim() && { summary_language: summaryLanguage.value.trim() }),
      });
    }
    const created = await request('/api/v1/jobs', { method: 'POST', headers, body });
    currentNote.value = await waitForJob(created.id);
    await loadLibrary();
  } catch (error) {
    submitError.value = error.message || 'Неизвестная ошибка.';
  } finally {
    isSubmitting.value = false;
  }
}

function useFile(event) {
  sourceFile.value = event.target.files?.[0] ?? null;
  if (sourceFile.value) {
    sourceText.value = '';
  }
}

function useText() {
  if (sourceText.value.trim()) {
    sourceFile.value = null;
  }
}

async function createFolder() {
  const name = folderName.value.trim();
  if (!name || folderBusy.value) {
    return;
  }
  folderBusy.value = true;
  libraryError.value = '';
  try {
    const folder = await request('/api/v1/library/folders', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }),
    });
    folderName.value = '';
    await loadLibrary();
    await selectFolder(folder.id);
  } catch (error) {
    libraryError.value = error.message;
  } finally {
    folderBusy.value = false;
  }
}

function startRename(folder) {
  renamingFolderId.value = folder.id;
  renamedFolder.value = folder.name;
}

async function saveRename(folder) {
  const name = renamedFolder.value.trim();
  if (!name || folderBusy.value) {
    return;
  }
  folderBusy.value = true;
  try {
    await request(`/api/v1/library/folders/${encodeURIComponent(folder.id)}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }),
    });
    renamingFolderId.value = null;
    await loadLibrary({ keepSelection: true });
  } catch (error) {
    libraryError.value = error.message;
  } finally {
    folderBusy.value = false;
  }
}

async function removeFolder(folder) {
  const count = Number(folder.note_count ?? folderCounts.value.get(folder.id) ?? 0);
  const noteText = count === 1 ? '1 конспект' : `${count} конспектов`;
  if (!window.confirm(`Удалить папку «${folder.name}» и ${noteText} внутри? Это действие нельзя отменить.`)) {
    return;
  }
  folderBusy.value = true;
  try {
    await request(`/api/v1/library/folders/${encodeURIComponent(folder.id)}`, { method: 'DELETE' });
    for (const [id, note] of noteCache) {
      if (note.folder_id === folder.id) noteCache.delete(id);
    }
    const removedCurrentFolder = selectedFolder.value === folder.id;
    if (removedCurrentFolder) {
      selectedFolder.value = 'all';
      await router.replace({ name: 'library', query: { ...route.query, folder: undefined } });
    }
    selectedNote.value = null;
    if (route.params.noteId) await router.push({ name: 'library', query: route.query });
    if (!removedCurrentFolder) await loadLibrary();
  } catch (error) {
    libraryError.value = error.message;
  } finally {
    folderBusy.value = false;
  }
}

async function moveNote(event) {
  if (!selectedNote.value || noteBusy.value) {
    return;
  }
  noteBusy.value = true;
  const folderId = event.target.value === 'unfiled' ? null : event.target.value;
  try {
    await request(`/api/v1/library/notes/${encodeURIComponent(selectedNote.value.id)}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ folder_id: folderId }),
    });
    selectedNote.value.folder_id = folderId;
    selectedNote.value.updated_at = new Date().toISOString();
    await loadLibrary({ keepSelection: true });
  } catch (error) {
    libraryError.value = error.message;
    await loadLibrary({ keepSelection: true });
  } finally {
    noteBusy.value = false;
  }
}

async function removeNote() {
  if (!selectedNote.value || noteBusy.value) {
    return;
  }
  if (!window.confirm(`Удалить конспект «${selectedNote.value.title}»? Это действие нельзя отменить.`)) {
    return;
  }
  noteBusy.value = true;
  try {
    await request(`/api/v1/library/notes/${encodeURIComponent(selectedNote.value.id)}`, { method: 'DELETE' });
    noteCache.delete(selectedNote.value.id);
    selectedNote.value = null;
    await router.push({ name: 'library', query: route.query });
    await loadLibrary();
  } catch (error) {
    libraryError.value = error.message;
  } finally {
    noteBusy.value = false;
  }
}

function formatDate(value) {
  return new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium' }).format(new Date(value));
}

function folderNameFor(folderId) {
  return folders.value.find((folder) => folder.id === folderId)?.name ?? 'Без папки';
}

async function copyMarkdown(note) {
  await navigator.clipboard.writeText(note.markdown ?? '');
  copied.value = true;
  window.setTimeout(() => { copied.value = false; }, 1600);
}

function downloadMarkdown(note) {
  const blobUrl = URL.createObjectURL(new Blob([note.markdown ?? ''], { type: 'text/markdown;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = blobUrl;
  link.download = `${(note.title || 'konspekt').replace(/[\\/:*?"<>|]/g, '-').slice(0, 80)}.md`;
  link.click();
  URL.revokeObjectURL(blobUrl);
}

watch(search, () => {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => {
    if (view.value === 'library') {
      router.replace({ name: route.name === 'library-note' ? 'library-note' : 'library', params: route.params, query: { ...route.query, q: search.value.trim() || undefined } });
    }
  }, 250);
});

function goCreate() {
  return router.push({ name: 'create' });
}

watch(() => route.fullPath, async (_path, previousPath) => {
  const folder = typeof route.query.folder === 'string' ? route.query.folder : 'all';
  const query = typeof route.query.q === 'string' ? route.query.q : '';
  const filtersChanged = folder !== selectedFolder.value || query !== search.value;
  selectedFolder.value = folder;
  search.value = query;

  if (view.value === 'create') {
    selectedNote.value = null;
    return;
  }
  if (filtersChanged || !previousPath) await loadLibrary();
  const noteId = typeof route.params.noteId === 'string' ? route.params.noteId : null;
  if (noteId) await loadNote(noteId);
  else selectedNote.value = null;
}, { immediate: true });

onMounted(loadLanguages);
</script>

<template>
  <div class="min-h-screen bg-[#f6f7f9] text-slate-800">
    <header class="sticky top-0 z-20 border-b border-slate-200/80 bg-white/90 backdrop-blur">
      <div class="mx-auto flex h-[68px] max-w-[1440px] items-center justify-between px-4 sm:px-7 lg:px-10">
        <a href="/" class="flex items-center gap-3 font-bold tracking-tight" @click.prevent="goCreate">
          <span class="grid size-9 place-items-center rounded-xl bg-indigo-600 text-sm font-extrabold text-white shadow-sm shadow-indigo-200">К</span>
          <span class="text-[17px]">Konspek<span class="text-indigo-600">AI</span></span>
        </a>
        <nav class="flex items-center gap-1 rounded-xl bg-slate-100 p-1" aria-label="Основная навигация">
          <button class="rounded-lg px-3 py-2 text-sm font-semibold transition sm:px-4" :class="view === 'create' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800'" @click="goCreate">Новый конспект</button>
          <button class="flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition sm:px-4" :class="view === 'library' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800'" @click="openLibrary">
            Библиотека
            <span v-if="allNotesCount" class="rounded-full bg-indigo-50 px-2 py-0.5 text-[11px] font-bold text-indigo-600">{{ allNotesCount }}</span>
          </button>
        </nav>
        <details class="relative">
          <summary class="flex size-10 cursor-pointer list-none items-center justify-center rounded-xl border border-slate-200 text-slate-500 transition hover:bg-slate-50" aria-label="Настройки доступа">
            <svg viewBox="0 0 24 24" class="size-[18px]" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="m19.4 15 1.2 1-.9 1.7-1.5-.4a7.8 7.8 0 0 1-1.8 1l-.3 1.6h-2l-.4-1.5a7.8 7.8 0 0 1-2-.1l-1 1.2-1.7-.9.4-1.5a7.8 7.8 0 0 1-1-1.8l-1.6-.3v-2l1.5-.4a7.8 7.8 0 0 1 .1-2l-1.2-1 .9-1.7 1.5.4a7.8 7.8 0 0 1 1.8-1l.3-1.6h2l.4 1.5a7.8 7.8 0 0 1 2 .1l1-1.2 1.7.9-.4 1.5a7.8 7.8 0 0 1 1 1.8l1.6.3v2l-1.5.4a7.8 7.8 0 0 1-.1 2Z" transform="translate(-1 -1) scale(1.08)"/></svg>
          </summary>
          <div class="absolute right-0 mt-3 w-[min(340px,calc(100vw-32px))] rounded-2xl border border-slate-200 bg-white p-4 shadow-xl shadow-slate-900/10">
            <label for="api-token" class="mb-2 block text-sm font-semibold">API-токен</label>
            <input id="api-token" v-model="apiToken" type="password" autocomplete="off" placeholder="Оставьте пустым для локального режима" class="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm outline-none focus:border-indigo-400 focus:ring-3 focus:ring-indigo-100">
            <p class="mt-2 text-xs leading-5 text-slate-500">Нужен только если сервер настроен на обязательный токен. Хранится до закрытия вкладки.</p>
          </div>
        </details>
      </div>
    </header>

    <main v-if="view === 'create'" class="mx-auto max-w-[1220px] px-4 pb-14 sm:px-7 lg:px-10">
      <section class="py-9 sm:py-12">
        <p class="mb-3 text-[11px] font-bold uppercase tracking-[.18em] text-indigo-600">ВИДЕО · АУДИО · ТЕКСТ</p>
        <h1 class="max-w-3xl text-3xl font-extrabold leading-tight tracking-tight text-slate-900 sm:text-[42px]">Превратите материал<br class="hidden sm:block"> в понятный конспект</h1>
        <p class="mt-4 max-w-2xl text-sm leading-7 text-slate-500 sm:text-base">Загрузите запись или вставьте текст. Готовый конспект автоматически появится в вашей библиотеке.</p>
      </section>

      <section class="grid gap-5 lg:grid-cols-[minmax(370px,.92fr)_minmax(0,1.08fr)]">
        <form class="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7" @submit.prevent="createNote">
          <div class="mb-7 flex items-center justify-between">
            <div><p class="text-[10px] font-bold tracking-[.16em] text-indigo-600">ШАГ 1</p><h2 class="mt-1 text-xl font-bold tracking-tight">Добавьте материал</h2></div>
            <span class="grid size-9 place-items-center rounded-full bg-slate-50 text-xs font-bold text-slate-400">01</span>
          </div>

          <label for="source-text" class="mb-2 block text-xs font-semibold text-slate-600">Текст или транскрипция</label>
          <textarea id="source-text" v-model="sourceText" rows="7" placeholder="Вставьте текст сюда…" class="w-full resize-y rounded-xl border border-slate-200 bg-white px-3.5 py-3 text-sm leading-6 outline-none transition placeholder:text-slate-400 focus:border-indigo-400 focus:ring-3 focus:ring-indigo-100" @input="useText"></textarea>

          <div class="my-5 flex items-center gap-3 text-[11px] text-slate-400"><span class="h-px flex-1 bg-slate-100"></span><span>или загрузите запись</span><span class="h-px flex-1 bg-slate-100"></span></div>
          <label for="media-file" class="flex cursor-pointer items-center gap-3 rounded-xl border border-dashed border-slate-300 bg-slate-50/70 p-3.5 transition hover:border-indigo-300 hover:bg-indigo-50/40">
            <span class="grid size-10 shrink-0 place-items-center rounded-xl bg-white text-lg text-indigo-600 shadow-sm">↑</span>
            <span class="min-w-0 flex-1"><strong class="block truncate text-xs font-semibold text-slate-700">{{ sourceFile?.name ?? 'Выберите аудио- или видеофайл' }}</strong><small class="mt-1 block text-[10px] text-slate-400">MP4, MOV, MKV, MP3, WAV, M4A и другие</small></span>
            <span class="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[10px] font-semibold text-slate-600">Обзор</span>
          </label>
          <input id="media-file" type="file" class="sr-only" accept="audio/*,video/*,.mp4,.mkv,.mov,.webm,.avi,.m4v,.wav,.mp3,.m4a,.aac,.ogg,.opus,.flac,.wma" @change="useFile">

          <div class="mt-5 grid grid-cols-2 gap-3">
            <label><span class="mb-2 block text-xs font-semibold text-slate-600">Язык речи</span><select v-model="language" class="w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-indigo-400"><option v-for="item in languages" :key="item.code" :value="item.code">{{ item.code === 'ru' ? 'Русский' : item.code }}</option></select></label>
            <label><span class="mb-2 block text-xs font-semibold text-slate-600">Формат конспекта</span><select v-model="summaryType" class="w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-indigo-400"><option value="detailed">Содержательный</option><option value="brief">Краткий</option><option value="bullet_points">Тезисный</option></select></label>
          </div>
          <label class="mt-4 block"><span class="mb-2 block text-xs font-semibold text-slate-600">Язык конспекта <span class="font-normal text-slate-400">необязательно</span></span><input v-model="summaryLanguage" type="text" maxlength="32" placeholder="По умолчанию — язык речи, например ru или en" class="w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm outline-none placeholder:text-slate-400 focus:border-indigo-400"></label>

          <div v-if="submitError && !isSubmitting && !currentNote" class="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-3 text-xs leading-5 text-rose-700" role="alert">{{ submitError }}</div>
          <div v-if="isSubmitting" class="mt-5 rounded-xl border border-indigo-100 bg-indigo-50/60 p-4" aria-live="polite"><div class="flex items-center gap-3"><span class="size-4 animate-spin rounded-full border-2 border-indigo-200 border-t-indigo-600"></span><div><p class="text-xs font-bold text-indigo-900">{{ progressTitle }}</p><p class="mt-1 text-[11px] text-indigo-700">{{ progressMessage }}</p></div></div><div class="mt-3 h-1 overflow-hidden rounded-full bg-indigo-100"><div class="h-full w-1/3 animate-pulse rounded-full bg-indigo-500"></div></div></div>

          <button type="submit" :disabled="isSubmitting" class="mt-5 flex w-full items-center justify-center gap-3 rounded-xl bg-indigo-600 px-4 py-3.5 text-sm font-bold text-white shadow-sm shadow-indigo-200 transition hover:bg-indigo-700 disabled:cursor-wait disabled:opacity-60"><span>{{ isSubmitting ? 'Обрабатываем…' : 'Создать конспект' }}</span><span aria-hidden="true">→</span></button>
          <p class="mt-3 text-center text-[10px] text-slate-400">Исходная запись удаляется после распознавания речи.</p>
        </form>

        <section class="min-h-[470px] rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7" aria-label="Результат конспектирования">
          <div v-if="!currentNote" class="flex min-h-[420px] flex-col items-center justify-center px-4 text-center">
            <div class="relative mb-6 grid size-24 place-items-center rounded-[28px] bg-indigo-50"><div class="absolute left-5 top-5 h-12 w-10 -rotate-6 rounded-lg border border-indigo-200 bg-white shadow-sm"></div><div class="absolute left-9 top-7 h-12 w-10 rotate-6 rounded-lg border border-indigo-300 bg-white shadow-sm"></div><span class="relative z-10 text-2xl text-indigo-600">✦</span></div>
            <p class="text-[10px] font-bold tracking-[.16em] text-indigo-600">ШАГ 2</p><h2 class="mt-2 text-xl font-bold tracking-tight text-slate-800">Здесь появится ваш конспект</h2><p class="mt-2 max-w-sm text-xs leading-6 text-slate-500">После обработки вы увидите заголовок, краткое содержание, разделы и ключевые тезисы.</p>
          </div>
          <article v-else class="max-w-none">
            <div class="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-4"><span class="flex items-center gap-2 text-[10px] font-bold tracking-[.13em] text-emerald-700"><span class="size-2 rounded-full bg-emerald-500"></span>ГОТОВО И СОХРАНЕНО В БИБЛИОТЕКЕ</span><div class="flex gap-2"><button class="rounded-lg border border-slate-200 px-3 py-2 text-[10px] font-semibold text-slate-600 hover:bg-slate-50" @click="copyMarkdown(currentNote)">{{ copied ? 'Скопировано' : 'Скопировать' }}</button><button class="rounded-lg border border-slate-200 px-3 py-2 text-[10px] font-semibold text-slate-600 hover:bg-slate-50" @click="downloadMarkdown(currentNote)">Скачать</button></div></div>
            <h2 class="mt-6 text-2xl font-extrabold leading-tight tracking-tight text-slate-900">{{ currentNote.title }}</h2>
            <p v-if="currentNote.summary" class="mt-4 text-sm leading-7 text-slate-600">{{ currentNote.summary }}</p>
            <section v-for="(section, index) in currentNote.sections ?? []" :key="`${index}-${section.heading}`" class="mt-6"><h3 class="text-base font-bold text-slate-800">{{ section.heading }}</h3><p class="mt-2 whitespace-pre-line text-sm leading-7 text-slate-600">{{ section.content }}</p></section>
            <section v-if="currentNote.key_points?.length" class="mt-7 rounded-xl border border-slate-100 bg-slate-50/80 p-4"><h3 class="text-sm font-bold text-slate-800">Ключевые тезисы</h3><ul class="mt-3 space-y-2.5 pl-5 text-sm leading-6 text-slate-600 marker:text-indigo-500"><li v-for="(point, index) in currentNote.key_points" :key="index">{{ point }}</li></ul></section>
            <button class="mt-5 text-xs font-semibold text-indigo-600 hover:text-indigo-800" @click="openLibrary">Открыть библиотеку →</button>
          </article>
        </section>
      </section>
    </main>

    <main v-else class="mx-auto max-w-[1440px] px-3 pb-10 pt-5 sm:px-6 lg:px-9">
      <div class="mb-5 flex flex-wrap items-end justify-between gap-3 px-1"><div><p class="text-[10px] font-bold uppercase tracking-[.17em] text-indigo-600">ВАША КОЛЛЕКЦИЯ</p><h1 class="mt-1 text-2xl font-extrabold tracking-tight text-slate-900 sm:text-[30px]">Библиотека конспектов</h1><p class="mt-1 text-xs text-slate-500">Все материалы в одном месте, папки помогают поддерживать порядок.</p></div><button class="rounded-xl bg-indigo-600 px-4 py-2.5 text-xs font-bold text-white shadow-sm hover:bg-indigo-700" @click="goCreate">＋ Новый конспект</button></div>
      <div class="grid min-h-[min(760px,calc(100vh-190px))] overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm lg:grid-cols-[235px_300px_minmax(0,1fr)]">
        <aside class="border-b border-slate-200 bg-slate-50/70 p-3.5 lg:border-b-0 lg:border-r">
          <div class="px-2 pb-2 pt-1 text-[10px] font-bold uppercase tracking-[.12em] text-slate-400">Библиотека</div>
          <button class="mb-1 flex w-full items-center justify-between rounded-lg px-2.5 py-2.5 text-left text-xs font-semibold transition" :class="selectedFolder === 'all' ? 'bg-indigo-50 text-indigo-700' : 'text-slate-600 hover:bg-white'" @click="selectFolder('all')"><span class="flex items-center gap-2.5"><span class="text-base">▤</span>Все конспекты</span><span class="text-[10px] text-slate-400">{{ allNotesCount }}</span></button>
          <button class="mb-3 flex w-full items-center justify-between rounded-lg px-2.5 py-2.5 text-left text-xs font-semibold transition" :class="selectedFolder === 'unfiled' ? 'bg-indigo-50 text-indigo-700' : 'text-slate-600 hover:bg-white'" @click="selectFolder('unfiled')"><span class="flex items-center gap-2.5"><span class="text-base">▱</span>Без папки</span><span class="text-[10px] text-slate-400">{{ unfiledNotesCount }}</span></button>
          <div class="mb-2 flex items-center justify-between px-2"><span class="text-[10px] font-bold uppercase tracking-[.12em] text-slate-400">Папки</span><span class="text-[10px] text-slate-400">{{ folders.length }}</span></div>
          <div v-for="folder in folders" :key="folder.id" class="group mb-0.5 flex items-center gap-1 rounded-lg" :class="selectedFolder === folder.id ? 'bg-indigo-50' : 'hover:bg-white'">
            <template v-if="renamingFolderId === folder.id"><input v-model="renamedFolder" autofocus maxlength="80" class="min-w-0 flex-1 rounded-md border border-indigo-200 bg-white px-2 py-1.5 text-xs outline-none" @keydown.enter.prevent="saveRename(folder)" @keydown.esc="renamingFolderId = null"><button class="px-1 text-xs font-semibold text-indigo-600" :disabled="folderBusy" @click="saveRename(folder)">Ок</button></template>
            <template v-else><button class="flex min-w-0 flex-1 items-center justify-between px-2.5 py-2.5 text-left text-xs font-medium" :class="selectedFolder === folder.id ? 'text-indigo-700' : 'text-slate-600'" @click="selectFolder(folder.id)"><span class="flex min-w-0 items-center gap-2.5"><span class="text-slate-400">▰</span><span class="truncate">{{ folder.name }}</span></span><span class="text-[10px] text-slate-400">{{ folder.note_count }}</span></button><div class="flex shrink-0 pr-1"><button class="grid size-6 place-items-center rounded text-[10px] text-slate-400 hover:bg-indigo-50 hover:text-indigo-600" :aria-label="`Переименовать папку ${folder.name}`" title="Переименовать папку" @click="startRename(folder)">···</button><button class="grid size-6 place-items-center rounded text-xs text-slate-400 hover:bg-rose-50 hover:text-rose-600" :aria-label="`Удалить папку ${folder.name} вместе с конспектами`" title="Удалить папку и все конспекты внутри" @click="removeFolder(folder)">×</button></div></template>
          </div>
          <form class="mt-4 border-t border-slate-200 pt-3" @submit.prevent="createFolder"><label for="new-folder" class="mb-2 block px-2 text-[10px] font-semibold text-slate-500">Новая папка</label><div class="flex gap-1.5"><input id="new-folder" v-model="folderName" maxlength="80" placeholder="Название" class="min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-xs outline-none placeholder:text-slate-400 focus:border-indigo-400"><button aria-label="Создать папку" class="grid size-8 shrink-0 place-items-center rounded-lg bg-slate-800 text-base text-white hover:bg-slate-700" :disabled="folderBusy || !folderName.trim()">＋</button></div></form>
          <p class="mt-4 px-2 text-[10px] leading-5 text-slate-400">Удаление папки также удалит все конспекты внутри неё.</p>
        </aside>

        <section class="flex min-h-[330px] flex-col border-b border-slate-200 lg:border-b-0 lg:border-r">
          <div class="border-b border-slate-100 p-3.5"><div class="flex items-center justify-between"><h2 class="truncate text-sm font-bold text-slate-800">{{ selectedFolder === 'all' ? 'Все конспекты' : selectedFolder === 'unfiled' ? 'Без папки' : folders.find((folder) => folder.id === selectedFolder)?.name ?? 'Папка' }}</h2><span class="ml-2 shrink-0 text-[10px] text-slate-400">{{ totalNotes }}</span></div><label class="mt-3 flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2"><span class="text-slate-400">⌕</span><input v-model="search" type="search" placeholder="Найти конспект" class="w-full bg-transparent text-xs outline-none placeholder:text-slate-400"></label></div>
          <div v-if="libraryError" class="m-3 rounded-lg bg-rose-50 px-3 py-2.5 text-[11px] leading-5 text-rose-700" role="alert">{{ libraryError }}</div>
          <div v-if="libraryLoading && !notes.length" class="p-5 text-center text-xs text-slate-400">Загружаем библиотеку…</div>
          <div v-else-if="!notes.length" class="flex flex-1 flex-col items-center justify-center px-5 py-12 text-center"><div class="grid size-12 place-items-center rounded-2xl bg-slate-100 text-xl text-slate-400">▤</div><p class="mt-3 text-xs font-semibold text-slate-700">{{ search ? 'Ничего не найдено' : 'Пока здесь пусто' }}</p><p class="mt-1 max-w-[190px] text-[10px] leading-5 text-slate-400">{{ search ? 'Попробуйте изменить поисковый запрос.' : 'Создайте конспект — он появится здесь автоматически.' }}</p></div>
          <div v-else class="flex-1 overflow-y-auto p-2">
            <button v-for="note in notes" :key="note.id" class="mb-1 w-full rounded-xl border p-3 text-left transition" :class="selectedNote?.id === note.id ? 'border-indigo-200 bg-indigo-50/70' : 'border-transparent hover:bg-slate-50'" @click="openNote(note.id)"><span class="block truncate text-xs font-semibold leading-5 text-slate-800">{{ note.title }}</span><span class="mt-1 line-clamp-2 block text-[10px] leading-4 text-slate-500">{{ note.summary }}</span><span class="mt-2.5 flex items-center justify-between gap-2 text-[9px] text-slate-400"><span class="truncate">{{ note.folder_id ? folderNameFor(note.folder_id) : 'Без папки' }}</span><span>{{ formatDate(note.created_at) }}</span></span></button>
            <button v-if="notes.length < totalNotes" class="w-full rounded-lg py-2 text-[10px] font-semibold text-indigo-600 hover:bg-indigo-50 disabled:text-slate-400" :disabled="libraryLoading" @click="loadMoreNotes">{{ libraryLoading ? 'Загружаем…' : 'Загрузить ещё' }}</button>
          </div>
        </section>

        <section class="min-h-[480px] bg-white">
          <div v-if="selectedNote" class="mx-auto max-w-3xl px-5 py-6 sm:px-8 sm:py-8">
            <div class="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-4"><div class="flex items-center gap-2 text-[10px] text-slate-400"><span>БИБЛИОТЕКА</span><span>/</span><span class="max-w-36 truncate font-medium text-slate-500">{{ folderNameFor(selectedNote.folder_id) }}</span></div><div class="flex gap-2"><button class="rounded-lg border border-slate-200 px-2.5 py-2 text-[10px] font-semibold text-slate-600 hover:bg-slate-50" @click="copyMarkdown(selectedNote)">{{ copied ? 'Скопировано' : 'Скопировать' }}</button><button class="rounded-lg border border-slate-200 px-2.5 py-2 text-[10px] font-semibold text-slate-600 hover:bg-slate-50" @click="downloadMarkdown(selectedNote)">Скачать</button><button class="rounded-lg border border-rose-100 px-2.5 py-2 text-[10px] font-semibold text-rose-600 hover:bg-rose-50" :disabled="noteBusy" @click="removeNote">Удалить</button></div></div>
            <div class="mt-7 flex flex-wrap items-center justify-between gap-3"><span class="text-[10px] text-slate-400">Создан {{ formatDate(selectedNote.created_at) }} · {{ selectedNote.summary_type === 'detailed' ? 'Содержательный' : selectedNote.summary_type === 'brief' ? 'Краткий' : 'Тезисный' }}</span><label class="flex items-center gap-2 text-[10px] font-medium text-slate-500"><span>Папка</span><select :value="selectedNote.folder_id ?? 'unfiled'" class="max-w-40 rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-[10px] outline-none focus:border-indigo-400" :disabled="noteBusy" @change="moveNote"><option value="unfiled">Без папки</option><option v-for="folder in folders" :key="folder.id" :value="folder.id">{{ folder.name }}</option></select></label></div>
            <h2 class="mt-5 text-2xl font-extrabold leading-tight tracking-tight text-slate-900 sm:text-[30px]">{{ selectedNote.title }}</h2>
            <p v-if="selectedNote.summary" class="mt-4 text-sm leading-7 text-slate-600">{{ selectedNote.summary }}</p>
            <section v-for="(section, index) in selectedNote.sections ?? []" :key="`${index}-${section.heading}`" class="mt-7"><h3 class="text-base font-bold text-slate-800">{{ section.heading }}</h3><p class="mt-2 whitespace-pre-line text-sm leading-7 text-slate-600">{{ section.content }}</p></section>
            <section v-if="selectedNote.key_points?.length" class="mt-8 rounded-xl border border-slate-100 bg-slate-50/80 p-4 sm:p-5"><h3 class="text-sm font-bold text-slate-800">Ключевые тезисы</h3><ul class="mt-3 space-y-2.5 pl-5 text-sm leading-6 text-slate-600 marker:text-indigo-500"><li v-for="(point, index) in selectedNote.key_points" :key="index">{{ point }}</li></ul></section>
          </div>
          <div v-else class="flex min-h-[480px] flex-col items-center justify-center px-6 text-center"><div class="grid size-14 place-items-center rounded-2xl bg-indigo-50 text-xl text-indigo-400">✦</div><h2 class="mt-4 text-sm font-bold text-slate-700">Выберите конспект</h2><p class="mt-1 max-w-xs text-xs leading-5 text-slate-400">Его содержимое откроется здесь. Новые готовые конспекты сохраняются в библиотеку автоматически.</p></div>
        </section>
      </div>
    </main>

    <footer v-if="view === 'create'" class="mx-auto flex max-w-[1220px] flex-wrap justify-between gap-2 px-4 pb-7 text-[10px] text-slate-400 sm:px-7 lg:px-10"><span>Ваши конспекты остаются в библиотеке, пока вы их не удалите.</span><a href="/docs" class="font-medium text-indigo-600 hover:text-indigo-800">Документация API</a></footer>
  </div>
</template>
