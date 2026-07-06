// Property inspector: one-click native login (WKWebView helper), manual token
// fallback, connection status, and duration overrides. Talks to the plugin via
// sendToPlugin / onSendToPropertyInspector.

$UD.connect();

$UD.onConnected(() => {
  document.querySelector('.udpi-wrapper').classList.remove('hidden');
  $UD.sendToPlugin({ type: 'getStatus' });
});

$UD.onSendToPropertyInspector((msg) => {
  const p = msg?.payload || {};
  if (p.type === 'status') {
    applyStatus(p);
  } else if (p.type === 'loginResult') {
    setLoginBusy(false);
    setError(p.ok ? '' : (p.error || 'Login failed'));
  }
});

function applyStatus(p) {
  setConnected(!!p.connected);
  if (typeof p.focusOverride === 'number' && p.focusOverride > 0) {
    document.getElementById('focus-override').value = p.focusOverride;
  }
  if (typeof p.breakOverride === 'number' && p.breakOverride > 0) {
    document.getElementById('break-override').value = p.breakOverride;
  }
}

function setConnected(connected) {
  const dot = document.getElementById('status-dot');
  const text = document.getElementById('status-text');
  dot.classList.toggle('ok', connected);
  dot.classList.remove('err');
  text.textContent = connected
    ? ($UD.t('statusConnected') || 'Connected ✓')
    : ($UD.t('statusDisconnected') || 'Not connected');
  document.getElementById('logout-btn').classList.toggle('hidden-block', !connected);
}

function setError(msg) {
  document.getElementById('error-hint').textContent = msg || '';
  if (msg) document.getElementById('status-dot').classList.add('err');
}

function setLoginBusy(busy) {
  const btn = document.getElementById('login-btn');
  btn.disabled = busy;
  btn.textContent = busy
    ? ($UD.t('loggingIn') || 'Waiting for login…')
    : ($UD.t('loginBtn') || 'Sign in to TickTick');
}

document.getElementById('login-btn').addEventListener('click', () => {
  setError('');
  setLoginBusy(true);
  $UD.sendToPlugin({ type: 'login' });
});

document.getElementById('logout-btn').addEventListener('click', () => {
  $UD.sendToPlugin({ type: 'logout' });
});

document.getElementById('token-btn').addEventListener('click', () => {
  const token = document.getElementById('token').value.trim();
  if (!token) return;
  setError('');
  $UD.sendToPlugin({ type: 'setToken', token });
  document.getElementById('token').value = '';
});

function saveDurations() {
  const focusOverride = parseInt(document.getElementById('focus-override').value, 10) || 0;
  const breakOverride = parseInt(document.getElementById('break-override').value, 10) || 0;
  $UD.sendToPlugin({ type: 'setDurations', focusOverride, breakOverride });
}

document.getElementById('focus-override').addEventListener('change', saveDurations);
document.getElementById('break-override').addEventListener('change', saveDurations);
