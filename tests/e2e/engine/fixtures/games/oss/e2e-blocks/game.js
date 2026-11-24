// E2E Blocks: GNOME's own small test game (AGPL-3.0-only, see LICENSE). Catch the falling blocks with the paddle;
// the best score is kept in localStorage. Written for GNOME's e2e suites (tests/e2e/engine/suites/games-player.mjs).
(function () {
  'use strict';
  var canvas = document.getElementById('board');
  var ctx = canvas.getContext('2d');
  var scoreEl = document.getElementById('score');
  var KEY = 'e2e-blocks-best';
  var best = Number(localStorage.getItem(KEY) || 0);
  var score = 0;
  var paddle = { x: 130, w: 60, h: 10 };
  var blocks = [];
  var frames = 0;
  function show() {
    scoreEl.textContent = 'Score ' + score + ' · Best ' + best;
  }
  function addPoint() {
    score += 1;
    if (score > best) {
      best = score;
      localStorage.setItem(KEY, String(best));
    }
    show();
  }
  // The suites call this to score without playing (a deterministic point).
  window.e2eScore = addPoint;
  window.e2eFrames = function () {
    return frames;
  };
  function step() {
    frames += 1;
    if (frames % 45 === 0) blocks.push({ x: Math.floor(Math.random() * 300), y: 0 });
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#7ad';
    for (var i = blocks.length - 1; i >= 0; i--) {
      var b = blocks[i];
      b.y += 3;
      ctx.fillRect(b.x, b.y, 20, 20);
      if (b.y + 20 >= canvas.height - paddle.h && b.x + 20 >= paddle.x && b.x <= paddle.x + paddle.w) {
        blocks.splice(i, 1);
        addPoint();
      } else if (b.y > canvas.height) blocks.splice(i, 1);
    }
    ctx.fillStyle = '#eee';
    ctx.fillRect(paddle.x, canvas.height - paddle.h, paddle.w, paddle.h);
    requestAnimationFrame(step);
  }
  document.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowLeft') paddle.x = Math.max(0, paddle.x - 20);
    if (e.key === 'ArrowRight') paddle.x = Math.min(canvas.width - paddle.w, paddle.x + 20);
  });
  canvas.addEventListener('pointermove', function (e) {
    var r = canvas.getBoundingClientRect();
    paddle.x = Math.max(0, Math.min(canvas.width - paddle.w, e.clientX - r.left - paddle.w / 2));
  });
  show();
  requestAnimationFrame(step);
})();
