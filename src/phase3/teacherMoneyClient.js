// The durable record contains identity and an unresolved ID only. It deliberately
// lives outside the tenant-cache namespace so logout cannot erase a dispatched save.
const requestId = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const exact = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const copy = value => JSON.parse(JSON.stringify(value));
const pendingKeys = ['version', 'projectId', 'uid', 'classroomId', 'requestId'];
const message = 'The save is not confirmed. Check its status before starting another money action.';

export function parseTeacherMoneyBalance(value) {
  if (typeof value !== 'string' || !/^-?(?:0|[1-9][0-9]{0,6})(?:\.[0-9]{1,2})?$/.test(value)) throw new Error('Enter a balance with no more than two decimal places.');
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (cents > 100000000) throw new Error('Enter a balance between -$1,000,000 and $1,000,000.');
  return negative ? -cents : cents;
}

export function teacherMoneyBalanceCents(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1000000 ||
      Math.abs(value * 100 - Math.round(value * 100)) > 0.0000001) throw new Error('Refresh the classroom and check the existing balance before adjusting it.');
  return Math.round(value * 100);
}

export function parseTeacherMoneyAmount(value) {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]{0,6})(?:\.[0-9]{1,2})?$/.test(value)) {
    throw new Error('Enter a positive amount with no more than two decimal places.');
  }
  const [whole, fraction = ''] = value.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (cents < 1 || cents > 100000000) throw new Error('Enter an amount from $0.01 to $1,000,000.');
  return cents;
}

export function createTeacherMoneyClient({ session, currentUid, storage, call, reload,
  confirmPlan, notify = () => {}, random = globalThis.crypto }) {
  let state = { status: 'unchecked', receipt: null, refreshed: false, reason: null };
  let busy = false;
  const snapshot = () => copy(state);
  function publish(next, captured) {
    if (captured && !current(captured)) return;
    state = next;
    // Rendering is not allowed to unwind a dispatched save or erase its marker.
    try { notify(snapshot()); } catch { /* Status remains recoverable. */ }
  }
  function capture() {
    const captured = session.captureIdentity();
    if (captured.role !== 'teacher' || !captured.uid || !captured.classroomId ||
        currentUid() !== captured.uid || !session.projectId) throw new Error(message);
    return captured;
  }
  const current = captured => session.validateCapturedIdentity(captured) && currentUid() === captured.uid;
  const key = captured => `morganBank:teacher-money-pending:v1:${JSON.stringify([session.projectId, captured.uid, captured.classroomId])}`;
  const record = (captured, id) => ({ version: 1, projectId: session.projectId,
    uid: captured.uid, classroomId: captured.classroomId, requestId: id });
  function readMarker(captured) {
    const text = storage.getItem(key(captured));
    if (text === null) return null;
    const marker = JSON.parse(text);
    if (!exact(marker, pendingKeys) || !requestId(marker.requestId) ||
        JSON.stringify(marker) !== JSON.stringify(record(captured, marker.requestId))) throw new Error(message);
    return marker;
  }
  function persist(captured, id) {
    const prior = readMarker(captured);
    if (prior && prior.requestId !== id) throw new Error(message);
    const marker = record(captured, id);
    storage.setItem(key(captured), JSON.stringify(marker));
    if (JSON.stringify(readMarker(captured)) !== JSON.stringify(marker)) throw new Error(message);
  }
  function clear(captured, id) {
    const marker = readMarker(captured);
    // A late completion cannot remove another tab's newer marker.
    if (marker && marker.requestId !== id) throw new Error(message);
    if (marker) storage.removeItem(key(captured));
    if (readMarker(captured)) throw new Error(message);
  }
  async function invoke(name, payload, captured) {
    if (!current(captured)) throw new Error(message);
    const result = await call(name, copy(payload));
    if (!current(captured)) throw new Error(message);
    return result;
  }
  function terminal(result, id) {
    if (result?.protocolVersion !== 1 || result.requestId !== id || !requestId(id)) throw new Error(message);
    if (typeof result.serverTime !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(result.serverTime) ||
        !Number.isFinite(Date.parse(result.serverTime)) || new Date(result.serverTime).toISOString() !== result.serverTime) throw new Error(message);
    if (result.status === 'cancelled' && result.action === 'cancel' && result.itemCount === 0 &&
        result.requiresRefresh === false) return result;
    if (result.status !== 'committed' || !['award', 'deduct', 'approve', 'deny', 'adjust', 'reset', 'createStudent'].includes(result.action) ||
        !Number.isInteger(result.itemCount) || result.itemCount < 1 || result.itemCount > 100 ||
        typeof result.acknowledged !== 'boolean' || result.requiresRefresh !== true ||
        typeof result.serverTime !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(result.serverTime) ||
        !Number.isFinite(Date.parse(result.serverTime)) || new Date(result.serverTime).toISOString() !== result.serverTime) throw new Error(message);
    if (result.action === 'createStudent' && (result.itemCount !== 1 ||
        !Number.isSafeInteger(result.studentId) || result.studentId <= 0 ||
        typeof result.loginId !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(result.loginId))) throw new Error(message);
    return result;
  }
  async function acceptTerminal(raw, captured, id, reason = null) {
    const receipt = terminal(raw, id);
    if (receipt.status === 'cancelled') {
      clear(captured, id);
      publish({ status: 'idle', receipt: null, refreshed: false, reason }, captured);
      return { status: 'cancelled', reason };
    }
    // A server pointer recovered after local-storage loss becomes durable too.
    persist(captured, id);
    publish({ status: 'committed', receipt: copy(receipt), refreshed: false, reason }, captured);
    let refreshed = false;
    try { refreshed = await reload(captured) === true; } catch { /* Receipt-only acknowledgment remains available. */ }
    if (!current(captured)) return { status: 'stale' };
    publish({ status: 'committed', receipt: copy(receipt), refreshed, reason }, captured);
    // Minimal recovery receipts establish a saved result, not its equivalence
    // to the current draft. Only a successful planned execute binds that intent.
    return { status: 'committed', refreshed, receipt: copy(receipt), intentConfirmed: false, reason };
  }
  const recoveryInput = (captured, id) => ({ protocolVersion: 1, classroomId: captured.classroomId, requestId: id });
  async function recover(captured, id, reason = null) {
    const status = await invoke('getTeacherMoneyStatusV2', recoveryInput(captured, id), captured);
    if (status?.protocolVersion !== 1) throw new Error(message);
    if (status.status === 'unconfirmed') {
      if (status.requestId !== id) throw new Error(message);
      if (id === null) {
        publish({ status: 'idle', receipt: null, refreshed: false, reason }, captured);
        return { status: 'idle' };
      }
      // Absence cannot unlock the UI: this atomic tombstone fences an invocation
      // that might still be in flight. One attempt, never an automatic retry loop.
      return acceptTerminal(await invoke('cancelTeacherMoneyV2', recoveryInput(captured, id), captured), captured, id, reason);
    }
    return acceptTerminal(status, captured, id ?? status.requestId, reason);
  }
  function blocked(captured, reason = null) {
    publish({ status: 'unresolved', receipt: null, refreshed: false, reason }, captured);
    return { status: 'unresolved', reason };
  }
  async function check() {
    if (busy) return { status: 'busy' };
    busy = true;
    let captured;
    const reason = state.reason;
    try {
      captured = capture();
      publish({ status: 'checking', receipt: null, refreshed: false, reason }, captured);
      return await recover(captured, readMarker(captured)?.requestId ?? null, reason);
    } catch { return captured ? blocked(captured, reason) : { status: 'stale' }; }
    finally { busy = false; }
  }
  async function run(input) {
    if (busy || state.status !== 'idle') return { status: 'blocked' };
    busy = true;
    let captured, id, dispatched = false, recoveryAttempted = false, rejectionReason = null;
    try {
      captured = capture();
      if (readMarker(captured)) return blocked(captured);
      publish({ status: 'planning', receipt: null, refreshed: false, reason: null }, captured);
      // Always resolve the current server pointer; another device can have saved.
      const status = await recover(captured, null);
      if (status.status !== 'idle') return status;
      publish({ status: 'planning', receipt: null, refreshed: false, reason: null }, captured);
      const access = await invoke('getClassroomAccessV2', {}, captured);
      if (access?.protocolVersion !== 1 || access.mode !== 'active' ||
          !Number.isSafeInteger(access.generation) || access.generation < 1) throw new Error(message);
      if (!random || typeof random.getRandomValues !== 'function') throw new Error(message);
      id = Array.from(random.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, '0')).join('');
      const draft = copy(input);
      if (draft.transactionIds) draft.transactionIds.sort((a, b) => a - b);
      if (draft.adjustments) draft.adjustments.sort((a, b) => a.studentId - b.studentId);
      const request = { ...draft, protocolVersion: 1, controlGeneration: access.generation, requestId: id };
      const preview = await invoke('planTeacherMoneyV2', request, captured);
      if (!preview?.plan || !preview.request || !Array.isArray(preview.selected) || preview.selected.length < 1) {
        publish({ status: 'idle', receipt: null, refreshed: false, reason: 'capacity' }, captured);
        return { status: 'capacity' };
      }
      const plan = preview.plan;
      const award = ['award', 'deduct'].includes(request.action);
      const ordered = award ? [...new Set(request.studentIds)].sort((a, b) => a - b) : [];
      const wholeGroup = !award && exact(preview.request, Object.keys(request)) && Object.keys(request).every(key => JSON.stringify(preview.request[key]) === JSON.stringify(request[key])) &&
        preview.notYetPlanned?.length === 0 && preview.selected.length <= 100 &&
        new Set(preview.selected.map(row => row.studentId)).size === preview.selected.length &&
        preview.selected.every(row => Number.isSafeInteger(row.studentId) && row.studentId > 0 &&
          typeof row.name === 'string' && Number.isSafeInteger(row.balanceCents) && Number.isSafeInteger(row.expectedBalanceCents));
      if (plan.projectId !== session.projectId || plan.teacherUid !== captured.uid ||
          plan.classroomId !== captured.classroomId || preview.request.requestId !== id ||
          preview.request.controlGeneration !== access.generation || preview.request.action !== request.action ||
          (!award && !wholeGroup) || (award && (
          !Array.isArray(preview.request.studentIds) ||
          preview.request.studentIds.length !== preview.selected.length ||
          !Array.isArray(preview.notYetPlanned) ||
          preview.notYetPlanned.length !== ordered.length - preview.selected.length ||
          preview.notYetPlanned.some((studentId, i) => studentId !== ordered[preview.selected.length + i]) ||
          !exact(preview.request, Object.keys(request)) ||
          Object.keys(request).some(field => field !== 'studentIds' && preview.request[field] !== request[field]) ||
          preview.selected.some((row, i) => row.studentId !== preview.request.studentIds[i] ||
            row.studentId !== ordered[i])))) throw new Error(message);
      publish({ status: 'confirming', receipt: null, refreshed: false, reason: null }, captured);
      if (!await confirmPlan(copy(preview)) || !current(captured)) {
        publish({ status: 'idle', receipt: null, refreshed: false, reason: null }, captured);
        return { status: 'declined' };
      }
      persist(captured, id);
      publish({ status: 'saving', receipt: null, refreshed: false, reason: null }, captured);
      dispatched = true;
      const result = await invoke('executeTeacherMoneyV2', { request: preview.request, plan }, captured);
      if (result?.status === 'rejected') {
        if (result.requestId !== id || result.digest !== plan.digest || result.wroteNothing !== true) throw new Error(message);
        rejectionReason = result.reason;
        recoveryAttempted = true;
        return await recover(captured, id, rejectionReason);
      }
      if (result?.action !== request.action || result.itemCount !== (award ? preview.selected.length :
          request.transactionIds?.length ?? request.adjustments?.length)) throw new Error(message);
      const accepted = await acceptTerminal(result, captured, id);
      return accepted.status === 'committed'
        ? { ...accepted, intentConfirmed: true, notYetPlanned: copy(preview.notYetPlanned) } : accepted;
    } catch {
      if (!captured || !current(captured)) return { status: 'stale' };
      if (dispatched) {
        if (recoveryAttempted) return blocked(captured, rejectionReason);
        try { return await recover(captured, id); } catch { return blocked(captured); }
      }
      // Persistence may have succeeded even when its verification failed.
      try { if (readMarker(captured)) return blocked(captured); } catch { return blocked(captured); }
      publish({ status: 'idle', receipt: null, refreshed: false, reason: 'unavailable' }, captured);
      return { status: 'unavailable' };
    } finally { busy = false; }
  }
  async function acknowledge() {
    if (busy || state.status !== 'committed') return { status: 'blocked' };
    busy = true;
    let captured;
    const prior = snapshot();
    try {
      captured = capture();
      const id = prior.receipt.requestId;
      const receipt = terminal(await invoke('acknowledgeTeacherMoneyV2', recoveryInput(captured, id), captured), id);
      if (receipt.status !== 'committed' || receipt.acknowledged !== true) throw new Error(message);
      clear(captured, id);
      publish({ status: 'idle', receipt: null, refreshed: prior.refreshed, reason: null }, captured);
      return { status: 'acknowledged', refreshed: prior.refreshed };
    } catch {
      // Keep the confirmed receipt and explicit control available; retrying
      // acknowledgment cannot apply money or clear a newer server pointer.
      if (captured && current(captured)) publish(prior, captured);
      return { status: 'unresolved' };
    } finally { busy = false; }
  }
  async function createStudent(input) {
    if (busy || state.status !== 'idle') return { status: 'blocked' };
    busy = true;
    let captured, id, dispatched = false;
    try {
      // This draft is memory-only. No PIN, name, balance or digest enters storage.
      const draft = copy(input);
      if (!exact(draft, ['name', 'startingBalanceCents', 'pin']) ||
          typeof draft.name !== 'string' || !draft.name.trim() || draft.name.length > 120 ||
          typeof draft.pin !== 'string' || !/^[0-9]{4}$/.test(draft.pin) ||
          !Number.isSafeInteger(draft.startingBalanceCents) || Math.abs(draft.startingBalanceCents) > 100000000) throw new Error(message);
      captured = capture();
      if (readMarker(captured)) return blocked(captured);
      publish({ status: 'checking', receipt: null, refreshed: false, reason: null }, captured);
      const status = await recover(captured, null);
      if (status.status !== 'idle') return status;
      const access = await invoke('getClassroomAccessV2', {}, captured);
      if (access?.protocolVersion !== 1 || access.mode !== 'active' ||
          !Number.isSafeInteger(access.generation) || access.generation < 1) throw new Error(message);
      id = Array.from(random.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, '0')).join('');
      const request = { ...draft, protocolVersion: 1, controlGeneration: access.generation,
        requestId: id, classroomId: captured.classroomId };
      persist(captured, id);
      publish({ status: 'saving', receipt: null, refreshed: false, reason: null }, captured);
      dispatched = true;
      const result = await invoke('createStudentV2', request, captured);
      if (result?.action !== 'createStudent') throw new Error(message);
      const accepted = await acceptTerminal(result, captured, id);
      return accepted.status === 'committed' ? { ...accepted, intentConfirmed: true } : accepted;
    } catch {
      if (!captured || !current(captured)) return { status: 'stale' };
      if (dispatched) {
        try { return await recover(captured, id); } catch { return blocked(captured); }
      }
      try { if (readMarker(captured)) return blocked(captured); } catch { return blocked(captured); }
      publish({ status: 'idle', receipt: null, refreshed: false, reason: 'unavailable' }, captured);
      return { status: 'unavailable' };
    } finally { busy = false; }
  }
  async function rename(input) {
    if (busy || state.status !== 'idle') return { status: 'blocked' };
    busy = true;
    let captured;
    try {
      captured = capture();
      if (readMarker(captured)) return blocked(captured);
      const access = await invoke('getClassroomAccessV2', {}, captured);
      if (access?.protocolVersion !== 1 || access.mode !== 'active' || !Number.isSafeInteger(access.generation) || access.generation < 1) throw new Error(message);
      const result = await invoke('editStudentProfileV2', { ...copy(input), protocolVersion: 1, controlGeneration: access.generation, classroomId: captured.classroomId }, captured);
      if (result?.protocolVersion !== 1 || result.studentId !== input.studentId || result.status !== 'saved' || result.requiresRefresh !== true) throw new Error(message);
      const refreshed = await reload(captured) === true;
      return current(captured) ? { status: 'saved', refreshed } : { status: 'stale' };
    } catch { return captured && current(captured) ? { status: 'unavailable' } : { status: 'stale' }; }
    finally { busy = false; }
  }
  return { run, createStudent, rename, check, acknowledge, getState: snapshot,
    reset() { state = { status: 'unchecked', receipt: null, refreshed: false, reason: null }; },
    isBlocked() { return busy || state.status !== 'idle'; } };
}
