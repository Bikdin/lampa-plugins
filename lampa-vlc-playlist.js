/*!
 * Lampa plugin: "VLC playlist"
 * Перехватывает запуск торрента (TorrServer) и вместо встроенного плеера
 * отдаёт во внешний плеер (VLC и т.п.) плейлист .m3u, начиная с выбранной серии.
 * VLC сам переключит на следующую серию.
 */
(function () {
    'use strict';

    if (window.__vlc_playlist_plugin) return;
    window.__vlc_playlist_plugin = true;

    var VIDEO_EXT = /\.(mkv|mp4|avi|m4v|mov|ts|m2ts|webm|wmv|mpg|mpeg|flv)$/i;

    function S(name, def) {
        var v = Lampa.Storage.get('vlcpl_' + name, def);
        return v === undefined || v === null || v === '' ? def : v;
    }
    function bool(v) { return v === true || v === 'true'; }
    function noty(t) { try { Lampa.Noty.show(t); } catch (e) { console.log('[vlc-pl]', t); } }

    /* ---------- разбор ссылки TorrServer ---------- */
    function parseTs(url) {
        if (typeof url !== 'string') return null;
        var link = url.match(/[?&]link=([^&]+)/);
        if (!link || url.indexOf('/stream') === -1) return null;
        var idx = url.match(/[?&]index=(\d+)/);
        var base = url.match(/^(https?:\/\/[^\/]+)/);
        return {
            base: base ? base[1] : '',
            hash: decodeURIComponent(link[1]),
            index: idx ? parseInt(idx[1], 10) : null
        };
    }

    function naturalCompare(a, b) {
        return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
    }

    /* ---------- сбор списка серий ---------- */
    // 1) из плейлиста, который Lampa передала плееру
    function fromLampaPlaylist(data, playlist) {
        if (!Array.isArray(playlist) || playlist.length < 2) return null;
        var items = playlist.filter(function (p) { return p && typeof p.url === 'string' && p.url; });
        if (items.length < 2) return null;
        var start = 0;
        for (var i = 0; i < items.length; i++) {
            if (items[i].url === data.url) { start = i; break; }
        }
        return items.slice(start).map(function (p) {
            return { title: p.title || p.name || '', url: p.url };
        });
    }

    // 2) у TorrServer: список файлов торрента
    function fromTorrServer(ts, done) {
        var url = ts.base + '/stream/fname?link=' + encodeURIComponent(ts.hash) + '&stat';
        fetch(url).then(function (r) { return r.json(); }).then(function (st) {
            var files = (st && (st.file_stats || st.FileStats)) || [];
            files = files.filter(function (f) { return VIDEO_EXT.test(f.path || f.Path || ''); })
                .map(function (f) { return { id: f.id || f.Id, path: f.path || f.Path }; })
                .sort(function (a, b) { return naturalCompare(a.path, b.path); });
            var start = 0;
            if (ts.index !== null) {
                for (var i = 0; i < files.length; i++) if (files[i].id === ts.index) { start = i; break; }
            }
            done(files.slice(start).map(function (f) {
                var name = f.path.split('/').pop();
                return {
                    title: name,
                    url: ts.base + '/stream/' + encodeURIComponent(name) + '?link=' + encodeURIComponent(ts.hash) + '&index=' + f.id + '&play'
                };
            }));
        }).catch(function (e) {
            console.log('[vlc-pl] stat error', e);
            done(null);
        });
    }

    function collect(data, playlist, done) {
        var list = fromLampaPlaylist(data, playlist);
        if (list) return done(list);
        var ts = parseTs(data.url);
        if (!ts) return done([{ title: data.title || '', url: data.url }]);
        fromTorrServer(ts, function (l) {
            done(l && l.length ? l : [{ title: data.title || '', url: data.url }]);
        });
    }

    function buildM3U(list) {
        var out = ['#EXTM3U'];
        list.forEach(function (it) {
            out.push('#EXTINF:-1,' + String(it.title || '').replace(/[\r\n]+/g, ' '));
            out.push(it.url);
        });
        return out.join('\r\n') + '\r\n';
    }

    /* ---------- запуск внешнего плеера ---------- */
    function nodeRequire() {
        try { if (typeof require === 'function') return require; } catch (e) {}
        try { if (window.nw && typeof window.require === 'function') return window.require; } catch (e) {}
        return null;
    }

    // десктопная Lampa (NW.js / Electron): запускаем vlc.exe напрямую
    function spawnPlayer(list) {
        var req = nodeRequire();
        var path = S('path', '');
        if (!req || !path) return false;
        try {
            req('child_process').spawn(path, list.map(function (i) { return i.url; }), {
                detached: true, stdio: 'ignore'
            }).unref();
            return true;
        } catch (e) {
            console.log('[vlc-pl] spawn error', e);
            return false;
        }
    }

    // браузер: скачиваем .m3u (браузер может сразу открыть его в VLC)
    function downloadM3U(list, name) {
        var blob = new Blob([buildM3U(list)], { type: 'audio/x-mpegurl' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = (name || 'playlist').replace(/[\\\/:*?"<>|]+/g, '_').slice(0, 80) + '.m3u';
        document.body.appendChild(a);
        a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 5000);
    }

    function copyText(text) {
        try {
            if (navigator.clipboard) return navigator.clipboard.writeText(text).then(function () { noty('Скопировано'); });
        } catch (e) {}
        var t = document.createElement('textarea');
        t.value = text; document.body.appendChild(t); t.select();
        try { document.execCommand('copy'); noty('Скопировано'); } catch (e) { noty(text); }
        t.remove();
    }

    // vlcpl:// — открывает VLC через обработчик из install-lampa-vlc.cmd
    function launchProto(ts) {
        var u = 'vlcpl://play?ts=' + encodeURIComponent(ts.base) +
            '&hash=' + encodeURIComponent(ts.hash) +
            '&index=' + (ts.index === null ? '' : ts.index);
        var a = document.createElement('a');
        a.href = u;
        document.body.appendChild(a);
        a.click();
        a.remove();
    }

    function openExternal(data, playlist) {
        var ts = parseTs(data.url);
        if (S('method', 'm3u') === 'proto' && ts && /^[A-Za-z0-9]{32,40}$/.test(ts.hash)) {
            launchProto(ts);
            noty('Открываю VLC…');
            return;
        }
        collect(data, playlist, function (list) {
            if (spawnPlayer(list)) {
                noty('Открываю в плеере: ' + list.length + ' сер.');
            } else {
                downloadM3U(list, data.title || 'playlist');
                noty('Плейлист: ' + list.length + ' сер. Откройте .m3u в VLC');
            }
        });
    }

    /* ---------- перехват Lampa.Player ---------- */
    var origPlay = Lampa.Player.play;
    var origPlaylist = Lampa.Player.playlist;
    var pending = null;

    Lampa.Player.playlist = function (pl) {
        if (pending) pending.playlist = pl;
        return origPlaylist.apply(this, arguments);
    };

    Lampa.Player.play = function (data) {
        var self = this, args = arguments;

        if (!bool(S('enabled', true)) || !data || !parseTs(data.url) ||
            (bool(S('skip_android', true)) && Lampa.Platform.is('android'))) {
            return origPlay.apply(self, args);
        }

        // Lampa обычно вызывает playlist() сразу после play() — ждём его
        pending = { data: data, playlist: data.playlist || null };
        var cur = pending;

        setTimeout(function () {
            pending = null;
            var playInternal = function () {
                origPlay.apply(self, args);
                if (cur.playlist) origPlaylist.call(Lampa.Player, cur.playlist);
            };

            if (S('mode', 'ask') === 'vlc') return openExternal(data, cur.playlist);

            var enabled = Lampa.Controller.enabled().name;
            Lampa.Select.show({
                title: 'Как смотреть?',
                items: [
                    { title: 'Внешний плеер (VLC) — с автопереходом', act: 'ext' },
                    { title: 'Встроенный плеер', act: 'int' },
                    { title: 'Скопировать ссылку на плейлист TorrServer', act: 'copy' }
                ],
                onSelect: function (a) {
                    Lampa.Controller.toggle(enabled);
                    if (a.act === 'ext') openExternal(data, cur.playlist);
                    else if (a.act === 'int') playInternal();
                    else {
                        var ts = parseTs(data.url);
                        copyText(ts.base + '/playlist?hash=' + encodeURIComponent(ts.hash));
                    }
                },
                onBack: function () { Lampa.Controller.toggle(enabled); }
            });
        }, 150);
    };

    /* ---------- настройки ---------- */
    function addSettings() {
        if (!Lampa.SettingsApi) return;
        Lampa.SettingsApi.addComponent({
            component: 'vlcpl',
            name: 'VLC плейлист',
            icon: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>'
        });
        Lampa.SettingsApi.addParam({
            component: 'vlcpl',
            param: { name: 'vlcpl_enabled', type: 'trigger', default: true },
            field: { name: 'Включить', description: 'Перехватывать запуск торрентов из TorrServer' }
        });
        Lampa.SettingsApi.addParam({
            component: 'vlcpl',
            param: { name: 'vlcpl_mode', type: 'select', values: { ask: 'Спрашивать', vlc: 'Сразу во внешний плеер' }, default: 'ask' },
            field: { name: 'Режим', description: 'Что делать при запуске серии' }
        });
        Lampa.SettingsApi.addParam({
            component: 'vlcpl',
            param: { name: 'vlcpl_method', type: 'select', values: { m3u: 'Скачать .m3u', proto: 'Ссылка vlcpl:// (нужен установщик)' }, default: 'm3u' },
            field: { name: 'Способ открытия', description: 'vlcpl:// открывает VLC сразу, без скачивания. Нужен install-lampa-vlc.cmd' }
        });
        Lampa.SettingsApi.addParam({
            component: 'vlcpl',
            param: { name: 'vlcpl_path', type: 'input', values: '', placeholder: 'C:\\Program Files\\VideoLAN\\VLC\\vlc.exe', default: '' },
            field: { name: 'Путь к плееру', description: 'Только для десктопного приложения Lampa. В браузере скачивается .m3u' }
        });
        Lampa.SettingsApi.addParam({
            component: 'vlcpl',
            param: { name: 'vlcpl_skip_android', type: 'trigger', default: true },
            field: { name: 'Не работать на Android', description: 'На Android используйте внешний плеер из настроек Lampa' }
        });
    }

    if (window.appready) addSettings();
    else Lampa.Listener.follow('app', function (e) { if (e.type === 'ready') addSettings(); });

    console.log('[vlc-pl] loaded');
})();
