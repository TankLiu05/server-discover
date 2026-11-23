'use strict';

const $ = id => document.getElementById(id);
const svgNS = 'http://www.w3.org/2000/svg';
const icon = name => {
  const svg = document.createElementNS(svgNS, 'svg');
  svg.classList.add('icon');
  const use = document.createElementNS(svgNS, 'use');
  use.setAttribute('href', '#i-' + name);
  svg.append(use);
  return svg;
};

let currentUser = null;
let gpuSamples = [];
let selectedGpuId = null;
let selectedGpuTime = null;
let registryRecords = [];
let previewedProcess = null;

const fmt = time => time ? new Date(time * 1000).toLocaleString('zh-CN') : '—';
const number = value => Number(value).toFixed(1);

function cell(row, value, className) {
  const td = document.createElement('td');
  td.textContent = String(value ?? '—');
  if (className) td.className = className;
  row.append(td);
  return td;
}

function message(value, error = false) {
  $('message').textContent = value;
  $('message').className = error ? 'error' : 'ok';
}

function showUser(user) {
  currentUser = user;
  $('authPanel').hidden = !!user;
  $('dashboard').hidden = !user;
  $('logout').hidden = !user;
  $('currentUser').hidden = !user;
  $('currentUser').textContent = user ? '登录用户：' + user.username : '';
}

async function api(path, options = {}) {
  const token = sessionStorage.getItem('monitorSession');
  const response = await fetch('/api' + path, {
    ...options,
    headers: {
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(options.body ? { 'Content-Type': 'application/json' } : {})
    }
  });
  if (!response.ok) {
    let body = {};
    try { body = await response.json(); } catch {}
    throw Error(typeof body.detail === 'string' ? body.detail : `请求失败 (${response.status})`);
  }
  return response.json();
}

function card(title, percent, detail, iconName) {
  const box = document.createElement('div');
  box.className = 'card';
  const heading = document.createElement('div');
  heading.className = 'card-heading';
  const emblem = document.createElement('span');
  emblem.className = 'card-icon';
  emblem.append(icon(iconName));
  const label = document.createElement('span');
  label.className = 'card-title';
  label.textContent = title;
  heading.append(emblem, label);
  const value = document.createElement('div');
  value.className = 'value';
  value.textContent = number(percent) + '%';
  const bar = document.createElement('div');
  bar.className = 'meter';
  const fill = document.createElement('span');
  fill.style.width = Math.max(0, Math.min(100, Number(percent) || 0)) + '%';
  bar.append(fill);
  const description = document.createElement('div');
  description.className = 'muted';
  description.textContent = detail;
  box.append(heading, value, bar, description);
  return box;
}

function ring(title, percent, detail, color) {
  const item = document.createElement('div');
  item.className = 'ring-item';
  const chart = document.createElement('div');
  chart.className = 'donut';
  const pct = Math.max(0, Math.min(100, Number(percent) || 0));
  chart.dataset.value = number(percent) + '%';
  chart.style.background = `conic-gradient(${color} ${pct}%, #eaf0f9 ${pct}% 100%)`;
  chart.setAttribute('role', 'img');
  chart.setAttribute('aria-label', title + '已用 ' + number(percent) + '%');
  const copy = document.createElement('div');
  const name = document.createElement('strong');
  name.textContent = title;
  const text = document.createElement('small');
  text.textContent = detail;
  copy.append(name, text);
  item.append(chart, copy);
  return item;
}

async function metrics() {
  const data = await api('/metrics');
  const box = $('cards');
  const rings = $('rings');
  box.replaceChildren();
  rings.replaceChildren();
  if (!data.timestamp) {
    box.textContent = '正在采样…';
    return;
  }
  $('sampleTime').textContent = '采样时间：' + fmt(data.timestamp);
  box.append(
    card('CPU 使用率', data.cpu_percent, '全部逻辑核心', 'cpu'),
    card('物理内存使用率', data.memory_percent,
      `已用 ${data.memory_used_gb} / 总量 ${data.memory_total_gb} GB · 可用 ${data.memory_available_gb} GB`, 'memory')
  );
  if (data.swap_total_gb > 0) {
    box.append(card('Swap 使用率', data.swap_percent,
      `已用 ${data.swap_used_gb} / 总量 ${data.swap_total_gb} GB`, 'memory'));
  }
  box.append(card('根分区使用率', data.disk_percent,
    `${data.disk_used_gb} / ${data.disk_total_gb} GB`, 'disk'));
  rings.append(
    ring('物理内存', data.memory_percent,
      `已用 ${data.memory_used_gb} / 总量 ${data.memory_total_gb} GB`, '#3477e7'),
    ring('根分区', data.disk_percent,
      `已用 ${data.disk_used_gb} / 总量 ${data.disk_total_gb} GB`, '#83aaf0')
  );
  if (data.gpu.available) {
    for (const gpu of data.gpu.devices) {
      box.append(
        card(`GPU ${gpu.index} 利用率`, gpu.utilization_percent, gpu.name, 'gpu'),
        card(`GPU ${gpu.index} 显存使用率`, gpu.memory_percent,
          `${gpu.memory_used_mb} / ${gpu.memory_total_mb} MiB · ${gpu.temperature_c ?? '—'} °C`, 'gpu')
      );
      rings.append(ring(`GPU ${gpu.index} 显存`, gpu.memory_percent,
        `已用 ${gpu.memory_used_mb} / 总量 ${gpu.memory_total_mb} MiB`, '#5d94ed'));
    }
  } else {
    const info = document.createElement('p');
    info.className = 'muted';
    info.textContent = 'GPU：' + data.gpu.error;
    box.append(info);
  }
}

function svgEl(tag, attributes = {}) {
  const element = document.createElementNS(svgNS, tag);
  for (const [key, value] of Object.entries(attributes)) {
    element.setAttribute(key, String(value));
  }
  return element;
}

function renderChart() {
  const container = $('gpuChart');
  container.replaceChildren();
  container.onkeydown = null;
  const selected = Number($('gpuSelect').value);
  if (selectedGpuId !== selected) selectedGpuTime = null;
  selectedGpuId = selected;

  const points = gpuSamples.flatMap(sample => {
    const gpu = sample.gpu.devices.find(device => device.index === selected);
    return gpu ? [{
      time: sample.timestamp,
      name: gpu.name,
      util: gpu.utilization_percent,
      memory: gpu.memory_percent,
      usedMb: gpu.memory_used_mb,
      totalMb: gpu.memory_total_mb,
      temperature: gpu.temperature_c
    }] : [];
  });
  if (!points.length) {
    selectedGpuTime = null;
    container.textContent = '暂无该显卡的历史采样数据';
    $('gpuPointName').textContent = 'GPU';
    for (const id of ['gpuPointTime', 'gpuPointUtil', 'gpuPointMemory', 'gpuPointCapacity', 'gpuPointTemperature']) $(id).textContent = '—';
    return;
  }

  const width = container.clientWidth || 800;
  const height = container.clientHeight || 300;
  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, 'aria-hidden': 'true' });
  const left = 48, right = width - 24, top = 16, bottom = height - 34;
  const first = points[0].time, last = points[points.length - 1].time;
  const x = time => first === last ? (left + right) / 2 : left + (time - first) / (last - first) * (right - left);
  const y = value => bottom - Math.max(0, Math.min(100, Number(value) || 0)) / 100 * (bottom - top);

  for (const pct of [0, 25, 50, 75, 100]) {
    svg.append(svgEl('line', { x1: left, y1: y(pct), x2: right, y2: y(pct), class: 'chart-gridline' }));
    const label = svgEl('text', { x: 3, y: y(pct) + 4, class: 'chart-axis-label' });
    label.textContent = pct + '%';
    svg.append(label);
  }
  for (const [key, className] of [['util', 'chart-line-util'], ['memory', 'chart-line-memory']]) {
    if (points.length > 1) {
      svg.append(svgEl('polyline', {
        points: points.map(point => `${x(point.time)},${y(point[key])}`).join(' '),
        class: className
      }));
    }
    if (points.length <= 24) {
      for (const point of points) {
        svg.append(svgEl('circle', { cx: x(point.time), cy: y(point[key]), r: 3.5, class: `chart-sample ${className}` }));
      }
    }
  }

  const guide = svgEl('line', { y1: top, y2: bottom, class: 'chart-guide' });
  const utilDot = svgEl('circle', { r: 6, class: 'chart-dot chart-dot-util' });
  const memoryDot = svgEl('circle', { r: 6, class: 'chart-dot chart-dot-memory' });
  svg.append(guide, utilDot, memoryDot);
  const axisTime = time => new Date(time * 1000).toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  });
  const start = svgEl('text', { x: left, y: height - 7, class: 'chart-axis-label' });
  start.textContent = axisTime(first);
  svg.append(start);
  if (last !== first) {
    const end = svgEl('text', { x: right, y: height - 7, class: 'chart-axis-label', 'text-anchor': 'end' });
    end.textContent = axisTime(last);
    svg.append(end);
  }
  container.append(svg);

  function selectPoint(index) {
    const point = points[index];
    selectedGpuTime = point.time;
    const position = x(point.time);
    guide.setAttribute('x1', position);
    guide.setAttribute('x2', position);
    utilDot.setAttribute('cx', position);
    utilDot.setAttribute('cy', y(point.util));
    memoryDot.setAttribute('cx', position);
    memoryDot.setAttribute('cy', y(point.memory));
    $('gpuPointName').textContent = `GPU ${selected} · ${point.name}`;
    $('gpuPointTime').textContent = fmt(point.time);
    $('gpuPointUtil').textContent = number(point.util) + '%';
    $('gpuPointMemory').textContent = number(point.memory) + '%';
    $('gpuPointCapacity').textContent = `已用 ${point.usedMb} / 总量 ${point.totalMb} MiB`;
    $('gpuPointTemperature').textContent = point.temperature == null ? '—' : number(point.temperature) + ' °C';
  }

  svg.onclick = event => {
    const bounds = svg.getBoundingClientRect();
    if (!bounds.width) return;
    const coordinate = (event.clientX - bounds.left) / bounds.width * width;
    let nearest = 0;
    for (let index = 1; index < points.length; index++) {
      if (Math.abs(x(points[index].time) - coordinate) < Math.abs(x(points[nearest].time) - coordinate)) nearest = index;
    }
    selectPoint(nearest);
  };
  container.onkeydown = event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const current = points.findIndex(point => point.time === selectedGpuTime);
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? points.length - 1
      : Math.max(0, Math.min(points.length - 1, current + (event.key === 'ArrowLeft' ? -1 : 1)));
    selectPoint(index);
  };
  const previous = points.findIndex(point => point.time === selectedGpuTime);
  selectPoint(previous >= 0 ? previous : points.length - 1);
}

function renderHistoryTable() {
  const body = $('history');
  body.replaceChildren();
  const selected = Number($('gpuSelect').value);
  for (const sample of gpuSamples.slice().reverse()) {
    const gpu = sample.gpu.devices.find(device => device.index === selected);
    if (!gpu) continue;
    const row = document.createElement('tr');
    [fmt(sample.timestamp), gpu.name, number(gpu.utilization_percent) + '%',
      number(gpu.memory_percent) + '%', gpu.memory_used_mb + ' / ' + gpu.memory_total_mb + ' MiB']
      .forEach(value => cell(row, value));
    body.append(row);
  }
  if (!body.children.length) body.textContent = '暂无该显卡的采样数据';
}

async function history() {
  const data = await api('/history?limit=288');
  gpuSamples = data;
  const gpuIds = new Map();
  for (const sample of data) {
    for (const gpu of sample.gpu.devices) gpuIds.set(gpu.index, gpu.name);
  }
  const select = $('gpuSelect');
  const previous = select.value;
  select.replaceChildren();
  for (const [id, name] of gpuIds) {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = `GPU ${id} · ${name}`;
    select.append(option);
  }
  if (previous !== '' && gpuIds.has(Number(previous))) select.value = previous;
  select.disabled = !gpuIds.size;
  renderChart();
  renderHistoryTable();
}

function renderServices() {
  const body = $('services');
  body.replaceChildren();
  const query = $('serviceSearch').value.trim().toLocaleLowerCase();
  const status = $('serviceStatus').value;
  const matches = registryRecords.filter(item =>
    (status === 'all' || item.status === status) &&
    (!query || [item.name, item.pid, item.started_by, item.registered_by]
      .some(value => String(value ?? '').toLocaleLowerCase().includes(query))));
  for (const item of matches) {
    const row = document.createElement('tr');
    [item.name, item.pid, item.started_by || '历史记录', item.registered_by || '历史记录',
      fmt(item.started_at), fmt(item.stopped_at)].forEach(value => cell(row, value));
    const statusCell = document.createElement('td');
    const badge = document.createElement('span');
    badge.className = 'badge ' + (item.status === 'running' ? '' : item.status);
    badge.textContent = item.status === 'running' ? '运行中' : item.status === 'stopped' ? '已停止' : '已退出';
    statusCell.append(badge);
    row.append(statusCell);
    const action = document.createElement('td');
    if (item.status === 'running' && item.user_id === currentUser.id) {
      const button = document.createElement('button');
      button.className = 'danger';
      button.type = 'button';
      button.append(icon('power'), '停止');
      button.onclick = () => stopService(item, button);
      action.append(button);
    }
    row.append(action);
    body.append(row);
  }
  $('servicesEmpty').hidden = matches.length > 0;
}

async function services() {
  registryRecords = await api('/services');
  for (const status of ['running', 'stopped', 'exited']) {
    $(status + 'Count').textContent = registryRecords.filter(item => item.status === status).length;
  }
  renderServices();
}

function clearPreview() {
  previewedProcess = null;
  $('processPreview').className = 'process-preview';
  $('processPreview').textContent = '输入 PID 后点击“核对 PID”，确认进程信息再登记。';
}

async function checkPid() {
  const pid = Number($('pid').value);
  const preview = $('processPreview');
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    preview.className = 'process-preview preview-error';
    preview.textContent = '请输入有效的 PID。';
    previewedProcess = null;
    return null;
  }
  const button = $('checkPid');
  button.disabled = true;
  preview.textContent = '正在核对进程…';
  try {
    const info = await api('/processes/' + pid);
    if (Number($('pid').value) !== pid) return null;
    previewedProcess = info;
    preview.className = 'process-preview preview-ready';
    preview.replaceChildren();
    const title = document.createElement('strong');
    title.textContent = info.name + ' · PID ' + info.pid;
    const detail = document.createElement('span');
    detail.textContent = `运行用户 ${info.user}　·　启动于 ${fmt(info.started_at)}　·　占用内存 ${info.memory_rss_mb} MiB`;
    const command = document.createElement('small');
    command.textContent = info.command || '无可见启动命令';
    command.title = info.command || '';
    preview.append(title, detail, command);
    return info;
  } catch (error) {
    if (Number($('pid').value) === pid) {
      previewedProcess = null;
      preview.className = 'process-preview preview-error';
      preview.textContent = error.message;
    }
    return null;
  } finally {
    button.disabled = false;
  }
}

async function find() {
  try {
    const data = await api('/processes?q=' + encodeURIComponent($('search').value.trim()));
    const body = $('processes');
    body.replaceChildren();
    for (const item of data) {
      const row = document.createElement('tr');
      [item.pid, item.name, item.user, number(item.memory_percent) + '%',
        item.memory_rss_mb == null ? '—' : item.memory_rss_mb + ' MiB',
        fmt(item.started_at), item.command].forEach((value, i) => cell(row, value, i === 6 ? 'command' : ''));
      const action = document.createElement('td');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'secondary';
      button.textContent = '填入登记';
      button.onclick = () => {
        $('pid').value = item.pid;
        $('serviceName').value = item.name;
        clearPreview();
        switchTab('registry');
        checkPid();
        $('serviceName').focus();
      };
      action.append(button);
      row.append(action);
      body.append(row);
    }
    if (!data.length) body.textContent = '未找到进程';
  } catch (error) {
    message(error.message, true);
  }
}

async function stopService(item, button) {
  if (!confirm(`确定向「${item.name}」(PID ${item.pid}) 发送停止信号吗？`)) return;
  button.disabled = true;
  try {
    await api(`/services/${item.id}/stop`, { method: 'POST' });
    message('已停止 ' + item.name);
    await services();
  } catch (error) {
    message(error.message, true);
    button.disabled = false;
  }
}

$('register').onsubmit = async event => {
  event.preventDefault();
  const pid = Number($('pid').value);
  const info = previewedProcess;
  if (!info || info.pid !== pid) {
    message('请先点击“核对 PID”并确认进程信息', true);
    return;
  }
  const button = $('registerButton');
  button.disabled = true;
  try {
    await api('/services', {
      method: 'POST',
      body: JSON.stringify({ pid, name: $('serviceName').value.trim(), expected_started_at: info.started_at })
    });
    message('登记成功');
    $('register').reset();
    clearPreview();
    await services();
  } catch (error) {
    message(error.message, true);
    if (error.message.includes('进程已变化')) clearPreview();
  } finally {
    button.disabled = false;
  }
};

async function authenticate(mode) {
  if (!$('authForm').reportValidity()) return;
  try {
    const result = await api('/auth/' + mode, {
      method: 'POST',
      body: JSON.stringify({ username: $('username').value.trim(), password: $('password').value })
    });
    sessionStorage.setItem('monitorSession', result.token);
    $('password').value = '';
    showUser(result.user);
    message(mode === 'register' ? '注册成功' : '登录成功');
    await refresh();
  } catch (error) {
    message(error.message, true);
  }
}

$('authForm').onsubmit = event => {
  event.preventDefault();
  authenticate('login');
};
$('signup').onclick = () => authenticate('register');
$('logout').onclick = async () => {
  try {
    await api('/auth/logout', { method: 'POST' });
  } finally {
    sessionStorage.removeItem('monitorSession');
    showUser(null);
    message('已退出登录');
  }
};

function switchTab(tab) {
  for (const view of document.querySelectorAll('[data-view]')) view.hidden = view.dataset.view !== tab;
  for (const button of document.querySelectorAll('[data-tab]')) {
    const active = button.dataset.tab === tab;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  if (tab === 'process' && !$('processes').children.length) find();
  if (tab === 'gpu') renderChart();
}

document.querySelectorAll('[data-tab]').forEach(button => button.onclick = () => switchTab(button.dataset.tab));
$('pid').oninput = clearPreview;
$('checkPid').onclick = checkPid;
$('serviceSearch').oninput = renderServices;
$('serviceStatus').onchange = renderServices;
$('reloadServices').onclick = () => services().catch(error => message(error.message, true));
$('gpuSelect').onchange = () => { renderChart(); renderHistoryTable(); };
$('find').onclick = find;
$('refresh').onclick = refresh;
$('search').onkeydown = event => { if (event.key === 'Enter') find(); };
window.addEventListener('resize', () => {
  if (currentUser && !document.querySelector('[data-view="gpu"]').hidden) renderChart();
});

async function refresh() {
  if (!currentUser) return;
  try {
    await Promise.all([metrics(), history(), services()]);
  } catch (error) {
    message(error.message, true);
    if (error.message.includes('登录')) {
      sessionStorage.removeItem('monitorSession');
      showUser(null);
    }
  }
}

async function initialize() {
  if (!sessionStorage.getItem('monitorSession')) return;
  try {
    showUser(await api('/auth/me'));
    await refresh();
  } catch {
    sessionStorage.removeItem('monitorSession');
    showUser(null);
  }
}

initialize();
setInterval(refresh, 30000);
