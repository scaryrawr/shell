// @ts-ignore
const Me = imports.misc.extensionUtils.getCurrentExtension();

import * as cfm from 'config_file_manager';
import * as launch from 'launcher_service';

const MRU_FILE = "mru_apps.json";
const MAX_ENTRIES = 15;

export class MruList {
  entries = new Array<string>();

  constructor() {
    this.reload();
  }

  add_recent(option: launch.SearchOption) {
    if (!("app" in option.id)) {
      return;
    }

    const id = option.id.app.filename;
    const index = this.entries.indexOf(id);
    if (index >= 0) {
      this.entries.splice(index, 1);
    }

    this.entries.push(id);

    const over = this.entries.length - MAX_ENTRIES;
    if (over > 0) {
      this.entries.splice(0, over);
    }

    this.sync_to_disk();
  }

  recent_score(option: launch.SearchOption): number | undefined {
    if (!("app" in option.id)) {
      return undefined;
    }
    const index = this.entries.indexOf(option.id.app.filename);
    if (index >= 0) {
      return (this.entries.length - 1) - index;
    }

    return undefined;
  }

  is_recent(option: launch.SearchOption): boolean {
    return this.recent_score(option) !== undefined;
  }

  reload() {
    const data = cfm.ConfigFileManager.read_type<string[]>(MRU_FILE);
    if (data.tag === 0) {
      this.entries = data.value;
    } else {
      log(`error loading mru list ${data.why}`);
    }
  }

  sync_to_disk() {
    const res = cfm.ConfigFileManager.write_type(MRU_FILE, this.entries);
    if (res.tag === 1) {
      log(`error writing mru list ${res.why}`);
    }
  }
}
