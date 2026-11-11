import { createRouter, createWebHistory } from 'vue-router';
import Workspace from './Workspace.vue';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'create', component: Workspace },
    { path: '/library', name: 'library', component: Workspace },
    { path: '/library/notes/:noteId', name: 'library-note', component: Workspace },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
});
