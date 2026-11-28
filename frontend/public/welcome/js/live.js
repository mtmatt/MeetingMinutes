/* Minutes · 會議紀錄, the public page: fills the live facts from the site's own API.
   - GET /api/auth/state   { registration: boolean }  -> shows 建立帳號 and points buy links at /register
   - GET /api/auth/pricing { onSale, packages[], rates, methods[], noExpiry, termsUrl, contact }
   The markup already holds the sample packages and rates, so the page reads finished without the API;
   this only replaces them with the live values. In-page #links are pointed at the current address, so they
   stay on this page whether it is served at "/" or at "/welcome/" (the <base> would send them to /welcome/). */
(function () {
  'use strict';
  var doc = document;
  var $all = function (sel, root) { return Array.prototype.slice.call((root || doc).querySelectorAll(sel)); };

  // in-page links: "#features" resolves against <base href="/welcome/">; keep them on this document
  var here = location.pathname + location.search;
  $all('a[href^="#"]').forEach(function (a) { a.setAttribute('href', here + a.getAttribute('href')); });

  var nf = new Intl.NumberFormat('zh-TW', { maximumFractionDigits: 2 });
  var ntd = function (n) { return 'NT$' + new Intl.NumberFormat('zh-TW', { maximumFractionDigits: 0 }).format(Math.round(n)); };
  var ntd2 = function (n) { return 'NT$' + new Intl.NumberFormat('zh-TW', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n); };
  var METHOD = { Credit: '信用卡', ATM: 'ATM 轉帳', CVS: '超商代碼' };
  var getJSON = function (url) {
    return fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function (r) { if (!r.ok) throw new Error(url + ' ' + r.status); return r.json(); });
  };
  var setText = function (sel, text) { $all(sel).forEach(function (el) { el.textContent = text; }); };
  var show = function (sel, on) { $all(sel).forEach(function (el) { el.hidden = !on; }); };

  var buyHref = '/login';

  function packageRow(p, onSale) {
    var li = doc.createElement('li');
    li.setAttribute('data-pkg', String(p.id || ''));
    var name = doc.createElement('span');
    name.className = 'rows__name';
    name.textContent = nf.format(p.points) + ' 點';
    var value = doc.createElement('span');
    value.className = 'rows__value';
    value.textContent = ntd(p.price);
    var per = doc.createElement('p');
    per.textContent = '每點 ' + ntd2(p.price / p.points);
    li.append(name, value, per);
    if (onSale) {
      var a = doc.createElement('a');
      a.className = 'btn btn--secondary';
      a.href = buyHref;
      a.setAttribute('data-buy', '');
      a.textContent = '購買 ' + nf.format(p.points) + ' 點';
      li.append(a);
    }
    return li;
  }

  function applyPricing(b) {
    if (!b || typeof b !== 'object') return;
    var pkgs = Array.isArray(b.packages) ? b.packages.filter(function (p) { return p && p.points > 0 && p.price >= 0; }) : [];
    var onSale = b.onSale !== false;

    // the package list
    $all('[data-prices]').forEach(function (list) {
      list.textContent = '';
      pkgs.forEach(function (p) { list.append(packageRow(p, onSale)); });
      list.hidden = pkgs.length === 0;
    });
    show('[data-prices-none]', pkgs.length === 0);
    show('[data-sale-soon]', pkgs.length > 0 && !onSale);

    // "預付點數 NT$100 起": the cheapest package
    if (pkgs.length) {
      var low = Math.min.apply(null, pkgs.map(function (p) { return p.price; }));
      setText('[data-price-from]', ntd(low));
    }
    show('[data-price-from-wrap]', pkgs.length > 0);

    // rates
    var r = b.rates || {};
    if (typeof r.perMinute === 'number') setText('[data-rate="perMinute"]', nf.format(r.perMinute));
    if (typeof r.perKInput === 'number') setText('[data-rate="perKInput"]', nf.format(r.perKInput));
    if (typeof r.perKOutput === 'number') setText('[data-rate="perKOutput"]', nf.format(r.perKOutput));
    if (typeof r.perMinute === 'number') {
      var hour = r.perMinute * 60;
      setText('[data-hour-points]', nf.format(Math.ceil(hour)));
      // the hour on the package with the lowest price a point
      var best = pkgs.slice().sort(function (x, y) { return x.price / x.points - y.price / y.points; })[0];
      if (best && hour > 0) {
        setText('[data-hour-pack]', nf.format(best.points));
        setText('[data-hour-price]', ntd(hour * best.price / best.points));
      }
      show('[data-hour-price-wrap]', !!best && hour > 0);
      show('[data-hour-wrap]', hour > 0);
    }

    // the one-hour example beside the packages: the real rates, and the smallest package that covers the hour
    if (typeof r.perMinute === 'number' && pkgs.length) {
      var asr = r.perMinute * 60;
      var sum = 30 * (r.perKInput || 0) + 8 * (r.perKOutput || 0);
      var total = asr + sum;
      var bySize = pkgs.slice().sort(function (x, y) { return x.points - y.points; });
      var pack = bySize.filter(function (p) { return p.points >= total; })[0] || bySize[bySize.length - 1];
      var pts = function (n) { return new Intl.NumberFormat('zh-TW', { maximumFractionDigits: 1 }).format(Math.round(n * 10) / 10); };
      setText('[data-ex-pack]', nf.format(pack.points));
      setText('[data-ex-pack2]', nf.format(pack.points));
      setText('[data-ex-pack-price]', ntd(pack.price));
      setText('[data-ex-asr]', pts(asr));
      setText('[data-ex-sum]', pts(sum));
      setText('[data-ex-left]', pts(pack.points - total));
      setText('[data-ex-total]', pts(total));
      setText('[data-ex-ntd]', ntd(total * pack.price / pack.points));
    }
    show('[data-example]', pkgs.length > 0);

    // payment methods: 信用卡、ATM 轉帳或超商代碼
    if (Array.isArray(b.methods) && b.methods.length) {
      var names = b.methods.map(function (m) { return METHOD[m] || String(m); });
      var text = names.length > 1 ? names.slice(0, -1).join('、') + '或' + names[names.length - 1] : names[0];
      setText('[data-methods]', text);
    }
    show('[data-no-expiry]', b.noExpiry === true);

    // terms and contact
    if (typeof b.termsUrl === 'string' && b.termsUrl) $all('a[data-terms]').forEach(function (a) { a.href = b.termsUrl; });
    var c = typeof b.contact === 'string' ? b.contact.trim() : '';
    if (c) {
      var href = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c) ? 'mailto:' + c : (/^https?:\/\//i.test(c) ? c : '');
      if (href) $all('a[data-contact]').forEach(function (a) { a.href = href; });
    }
  }

  function applyState(s) {
    var open = !!(s && s.registration === true);
    show('[data-register]', open);
    buyHref = open ? '/register' : '/login';
    $all('a[data-buy]').forEach(function (a) { a.href = buyHref; });
  }

  var state = getJSON('/api/auth/state').then(applyState, function () {});
  var pricing = getJSON('/api/auth/pricing');
  Promise.all([state, pricing.catch(function () { return null; })]).then(function (res) { if (res[1]) applyPricing(res[1]); });
})();
