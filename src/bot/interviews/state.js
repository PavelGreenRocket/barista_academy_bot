// src/bot/interviews/state.js

// Используем Map для хранения состояния (просмотра списка, создания, редактирования) по telegram_id админа
const interviewViewState = new Map();
const candidateCreateState = new Map();
const candidateEditState = new Map();
const archiveReasonFilter = new Map(); // сейчас не используется, оставляем на будущее
const interviewResultState = new Map(); // состояние "собеседование пройдено"
const declineReasonState = new Map(); // состояние "причина отказа/отмены"

// Получить/установить состояние просмотра списка кандидатов (фильтры)
function getInterviewViewState(userId) {
  return interviewViewState.get(userId) || {};
}
function setInterviewViewState(userId, newState) {
  const current = interviewViewState.get(userId) || {};
  interviewViewState.set(userId, { ...current, ...newState });
}
function clearInterviewViewState(userId) {
  interviewViewState.delete(userId);
}

// Состояние пошагового создания кандидата (текущий шаг и накопленные данные)
function setCandidateCreateState(userId, state) {
  candidateCreateState.set(userId, state);
}
function getCandidateCreateState(userId) {
  return candidateCreateState.get(userId);
}
function clearCandidateCreateState(userId) {
  candidateCreateState.delete(userId);
}

// Состояние редактирования отдельного поля кандидата
function setCandidateEditState(userId, state) {
  candidateEditState.set(userId, state);
}
function getCandidateEditState(userId) {
  return candidateEditState.get(userId);
}
function clearCandidateEditState(userId) {
  candidateEditState.delete(userId);
}

// Состояние результата собеседования (опрос "вовремя/опоздал/замечания")
function setInterviewResultState(userId, state) {
  interviewResultState.set(userId, state);
}

function getInterviewResultState(userId) {
  return interviewResultState.get(userId) || null;
}

function clearInterviewResultState(userId) {
  interviewResultState.delete(userId);
}

// Состояние ввода причины отказа/отмены
// { candidateId, mode: 'decline' | 'cancel' }
function setDeclineReasonState(userId, state) {
  declineReasonState.set(userId, state);
}
function getDeclineReasonState(userId) {
  return declineReasonState.get(userId) || null;
}
function clearDeclineReasonState(userId) {
  declineReasonState.delete(userId);
}

// Фильтр архива (пока не используем, оставлено на будущее)
function setArchiveReasonFilter(userId, reasonCode) {
  if (reasonCode) {
    archiveReasonFilter.set(userId, reasonCode);
  } else {
    archiveReasonFilter.delete(userId);
  }
}
function getArchiveReasonFilter(userId) {
  return archiveReasonFilter.get(userId) || null;
}
function clearArchiveReasonFilter(userId) {
  archiveReasonFilter.delete(userId);
}

module.exports = {
  getInterviewViewState,
  setInterviewViewState,
  clearInterviewViewState,

  setCandidateCreateState,
  getCandidateCreateState,
  clearCandidateCreateState,

  setCandidateEditState,
  getCandidateEditState,
  clearCandidateEditState,

  setArchiveReasonFilter,
  getArchiveReasonFilter,
  clearArchiveReasonFilter,

  setInterviewResultState,
  getInterviewResultState,
  clearInterviewResultState,

  setDeclineReasonState,
  getDeclineReasonState,
  clearDeclineReasonState,
};
