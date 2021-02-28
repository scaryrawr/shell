//@ts-ignore
const Me = imports.misc.extensionUtils.getCurrentExtension();

const { Clutter, Gio, GLib, Meta } = imports.gi;

import * as app_info from 'app_info';
import * as error from 'error';
import * as lib from 'lib';
import * as log from 'log';
import * as result from 'result';
import * as search from 'dialog_search';
import * as launch from 'launcher_service';
import * as mru from 'mru_app_list';
import * as plugins from 'launcher_plugins';

import type { ShellWindow } from 'window';
import type { Ext } from 'extension';
import type { AppInfo } from 'app_info';

const { OK } = result;

const HOME_DIR: string = GLib.get_home_dir();
const DATA_DIRS: string = GLib.get_system_data_dirs();

/// Search paths for finding applications
const SEARCH_PATHS: Array<[string, string]> = [
    // System-wide
    ["System", "/usr/share/applications/"],
    ["System (Local)", "/usr/local/share/applications/"],
    // User-local
    ["User", HOME_DIR + "/.local/share/applications/"],
    // System-wide flatpaks
    ["Flatpak (System)", "/var/lib/flatpak/exports/share/applications/"],
    // User-local flatpaks
    ["Flatpak (User)", HOME_DIR + "/.local/share/flatpak/exports/share/applications/"],
    // System-wide Snaps
    ["Snap (System)", "/var/lib/snapd/desktop/applications/"],
	// Lutris flatpak
    ["Lutris (Flatpak)", HOME_DIR + "/.var/app/net.lutris.Lutris/data/applications/"]
];

const INVALID_REGEX_CHARS = '.()[\\+$^*|?';

const REGEX_CACHE = new Map<string, RegExp>();
function build_regex(pattern: string): RegExp {
    let expression = REGEX_CACHE.get(pattern);
    if (expression === undefined) {
        expression = new RegExp(pattern.split('').reduce((reg: string, char: string) => {
            const part = (INVALID_REGEX_CHARS.includes(char)) ? `.*\${char}` : `.*${char}`;
            return reg + part;
        }, ''), 'ig');

        REGEX_CACHE.set(pattern, expression);
    }

    return expression;
}

type ScoredSearchOption = launch.SearchOption & {
    /** Score for sort ranking */
    score?: number;
};

export class Launcher extends search.Search {
    options: Array<launch.SearchOption>
    desktop_apps: Array<[string, AppInfo]>
    service: launch.LauncherService
    last_plugin: null | plugins.Plugin.Source
    mode: number;
    mru_list?: mru.MruList;

    constructor(ext: Ext) {
        let cancel = () => {
            ext.overlay.visible = false;
            this.stop_services(ext)
        };

        let search = (pattern: string): Array<launch.SearchOption> | null => {
            this.options.splice(0)

            if (pattern.length == 0) {
                this.list_workspace(ext);
                return this.options
            }

            this.last_plugin = null

            this.service.query(ext, pattern, (plugin, response) => {
                if (response.event === "queried") {
                    for (const selection of response.selections) {
                        if (!this.last_plugin) this.last_plugin = plugin;

                        let icon = null
                        if (selection.icon) {
                            icon = { name: selection.icon }
                        } else if (selection.content_type) {
                            icon = { gicon: Gio.content_type_get_icon(selection.content_type) }
                        }

                        this.options.push(new launch.SearchOption(
                            selection.name,
                            selection.description,
                            plugin.config.icon,
                            icon,
                            this.icon_size(),
                            { plugin, id: selection.id }
                        ))
                    }
                }
            })

            const needles = build_regex(pattern);

            // Filter matching windows
            const windows = ext.tab_list(Meta.TabList.NORMAL, null)
                .filter(window => window.name(ext).search(needles) >= 0 || window.meta.get_title().search(needles) >= 0)
                .map(window => window_selection(ext, window, this.icon_size()));

            // Filter matching desktop apps
            const apps = this.desktop_apps
                .filter(info => info[1].name().search(needles) >= 0 || info[1].desktop_name.search(needles) >= 0 || lib.ok(info[1].generic_name(), (s) => s.search(needles) >= 0))
                .map(info => new launch.SearchOption(
                    info[1].name(),
                    info[1].generic_name() ? `${info[1].generic_name()} - ${info[0]}` : info[0],
                    'application-default-symbolic',
                    { gicon: info[1].icon() },
                    this.icon_size(),
                    { app: info[1] }
                ));

            this.mru_list = this.mru_list ?? new mru.MruList();
            const sorter = (a: ScoredSearchOption, b: ScoredSearchOption) => {
                if (this.mru_list) {
                    const a_recent = this.mru_list.recent_score(a);
                    const b_recent = this.mru_list.recent_score(b);
                    if (a_recent !== undefined && b_recent === undefined) {
                        return -1;
                    }

                    if (b_recent !== undefined && a_recent === undefined) {
                        return 1;
                    }

                    if (a_recent !== undefined && b_recent !== undefined) {
                        return a_recent > b_recent ? 1 : -1;
                    }
                }
                
                const scorer = (opt: ScoredSearchOption) => {
                    const opt_name = opt.title;
                    const opt_index = opt_name.search(needles);
                    if (opt_index < 0) {
                        return;
                    }

                    const opt_lengths = opt_name.match(needles)?.map(s => s.length);
                    const opt_length = opt_lengths ? Math.min(...opt_lengths) : 9999;
                    opt.score = opt_index + opt_length;
                };

                if (a.score === undefined) {
                    scorer(a);
                }

                if (b.score === undefined) {
                    scorer(b);
                }

                return (!a.score && !b.score) ? (a.title > b.title ? 1 : 0) :
                    !a.score ? 1 :
                    !b.score ? -1 :
                    (a.score < b.score) ? -1 :
                    (b.score < a.score) ? 1 :
                    0;
            }

            // Sort the list of matched selections
            windows.sort(sorter)
            this.options.push(...apps)
            this.options.sort(sorter);
            this.options = windows.concat(this.options)

            // Truncate excess items from the list
            this.options.splice(this.list_max());

            if (this.options.length == 0) {
                this.service.query(ext, `bing ${pattern}`, (plugin, response) => {
                    if (!this.last_plugin) this.last_plugin = plugin;
    
                    if (response.event === "queried") {
                        for (const selection of response.selections) {
                            let icon = null
                            if (selection.icon) {
                                icon = { name: selection.icon }
                            } else if (selection.content_type) {
                                icon = { gicon: Gio.content_type_get_icon(selection.content_type) }
                            }
    
                            this.options.push(new launch.SearchOption(
                                selection.name,
                                selection.description,
                                plugin.config.icon,
                                icon,
                                this.icon_size(),
                                { plugin, id: selection.id }
                            ))
                        }
                    }
                })
            }

            return this.options;
        };

        let select = (id: number) => {
            ext.overlay.visible = false

            if (id >= this.options.length) return

            const selected = this.options[id]
            if (selected) {
                if ("window" in selected.id) {
                    const win = selected.id.window
                    if (win.workspace_id() == ext.active_workspace()) {
                        const { x, y, width, height } = win.rect()
                        ext.overlay.x = x
                        ext.overlay.y = y
                        ext.overlay.width = width
                        ext.overlay.height = height
                        ext.overlay.visible = true
                    }
                }
            }
        };

        let apply = (index: number): boolean => {
            ext.overlay.visible = false;

            const selected = this.options[index];

            if (typeof selected === 'undefined') {
                return true
            }

            const option = selected.id
            this.mru_list?.add_recent(selected);

            if ("window" in option) {
                option.window.activate()
            } else if ("app" in option) {
                const result = option.app.launch()
                if (result instanceof error.Error) {
                    log.error(result.format());
                } else {
                    let exec_name = option.app.app_info.get_executable();
                    if (exec_name === "gnome-control-center") {
                        for (const window of ext.tab_list(Meta.TabList.NORMAL, null)) {
                            if (window.meta.get_title() === "Settings") {
                                window.meta.activate(global.get_current_time());
                                break;
                            }
                        }
                    }
                }
            } else if ("plugin" in option) {
                const { plugin, id } = option
                plugins.Plugin.submit(ext, plugin, id)

                const response = plugins.Plugin.listen(plugin)
                if (response) {
                    if (response.event === "fill") {
                        this.set_text(response.text)
                        return true
                    }
                }

            }

            return false
        };

        let complete = () => {
            if (this.last_plugin) {
                plugins.Plugin.complete(ext, this.last_plugin)
                const res = plugins.Plugin.listen(this.last_plugin)
                if (res && res.event === "fill") {
                    this.set_text(res.text)
                }
            }
        }

        super(cancel, search, complete, select, apply);

        this.dialog.dialogLayout._dialog.y_align = Clutter.ActorAlign.START;
        this.dialog.dialogLayout._dialog.x_align = Clutter.ActorAlign.START;
        this.dialog.dialogLayout.y = 48;

        this.service = new launch.LauncherService()
        this.last_plugin = null
        this.options = new Array()
        this.desktop_apps = new Array();
        this.mode = -1;
    }

    load_desktop_files() {
        lib.bench("load_desktop_files", () => {
            this.desktop_apps.splice(0);
            for (const [where, path] of SEARCH_PATHS) {
                for (const result of app_info.load_desktop_entries(path)) {
                    if (result.kind == OK) {
                        const value = result.value;
                        this.desktop_apps.push([where, value]);
                    } else {
                        const why = result.value;
                        log.warn(why.context(`failed to load desktop app`).format());
                    }
                }
            }
            for (const _path of DATA_DIRS) {
                const path = _path.replace(/\/$/, '') + "/applications";
                for (const result of app_info.load_desktop_entries(path)) {
                    if (result.kind == OK) {
                        const value = result.value;
                        const existAt = this.desktop_apps.findIndex(([ _, app ]) => app.exec() == value.exec());
                        if (existAt == -1) {
                            this.desktop_apps.push(['System', value]);
                        }
                    } else {
                        const why = result.value;
                        log.warn(why.context(`failed to load desktop app`).format());
                    }
                }
            }
        });
    }

    list_workspace(ext: Ext) {
        let show_all_workspaces = true;
        const active = ext.active_workspace();
        for (const window of ext.tab_list(Meta.TabList.NORMAL, null)) {
            if (show_all_workspaces || window.workspace_id() === active) {
                this.options.push(window_selection(ext, window, this.icon_size()))
                if (this.options.length == this.list_max()) break;
            }
        }
    }

    open(ext: Ext) {
        const mon = ext.monitor_work_area(ext.active_monitor());

        this.options.splice(0);
        this.clear();

        this.dialog.dialogLayout.x = (mon.width / 2) - (this.dialog.dialogLayout.width / 2);
        this.dialog.dialogLayout.y = (mon.height / 2) - (this.dialog.dialogLayout.height);

        this.list_workspace(ext);
        this.update_search_list(this.options);

        this.dialog.open(global.get_current_time(), false);
    }

    stop_services(ext: Ext) {
        this.service.stop_services(ext)
    }
}

function window_selection(ext: Ext, window: ShellWindow, icon_size: number): launch.SearchOption {
    let name = window.name(ext);
    let title = window.meta.get_title();

    return new launch.SearchOption(
        title,
        name,
        'focus-windows-symbolic',
        {
            widget: window.icon(ext, icon_size)
        },
        icon_size,
        { window }
    )
}
