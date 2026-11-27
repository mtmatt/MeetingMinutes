/* The two head lines of the kit (starter.html), moved into a file so the page runs under a
   Content-Security-Policy without inline scripts: the hero's words wait for motion.js (m-enter, 700ms
   mark) and a moment that waits for its module gets its 2.5 s safety mark (mo-js, mo-safe). */
document.documentElement.classList.add('m-enter');
setTimeout(() => document.documentElement.classList.add('m-enter-done'), 700);
document.documentElement.classList.add('mo-js');
setTimeout(() => document.documentElement.classList.add('mo-safe'), 2500);
