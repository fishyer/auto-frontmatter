import {
	App,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	moment,
	TagCache
} from "obsidian";
import { v4 as uuidv4 } from "uuid";

interface FrontmatterModifiedSettings {
	updatedProperty: string;
	// 添加created_at属性
	createdProperty: string;
	uuidProperty: string;
	slugProperty: string;
	zhihuTagsProperty: string;
	momentFormat: string;
	excludedFolders: string[];
	useKeyupEvents: boolean;
	onlyUpdateExisting: boolean;
	timeout: number;
	excludeField: string;
	appendField: string;
	appendMaximumFrequency: moment.unitOfTime.StartOf;
}

const DEFAULT_SETTINGS: FrontmatterModifiedSettings = {
	updatedProperty: "lastmod",
	// 添加created_at的默认值
	createdProperty: "date",
	uuidProperty: "id",
	slugProperty: "slug",
	zhihuTagsProperty:"zhihu-tags",
	momentFormat: "YYYY-MM-DDTHH:mm:ss+08:00",
	excludedFolders: [],
	useKeyupEvents: false,
	onlyUpdateExisting: false,
	timeout: 10,
	excludeField: "exclude_modified_update",
	appendField: "append_modified_update",
	appendMaximumFrequency: "day", // Append a maximum of 1 row per 'unit'
};

export default class FrontmatterModified extends Plugin {
	settings: FrontmatterModifiedSettings;
	timer: { [key: string]: number } = {};

	async onload() {
		await this.loadSettings();

		if (!this.settings.useKeyupEvents) {
			/*
			 * This is the default mode, where we watch for a change in the editor and then
			 * update the frontmatter.
			 *
			 * For users who experience issues due to external programs modifying their files,
			 * they can use the special 'useKeyupEvents' mode below.
			 */
			this.registerEvent(
				this.app.workspace.on("editor-change", (editor, info) => {
					if (info.file instanceof TFile) {
						this.updateFrontmatter(info.file);
					}
				})
			);
		} else if (this.settings.useKeyupEvents) {
			/*
			 * This is a special mode for users who can't rely on Obsidian detecting file changes.
			 * Both of these built-in events fire when a file is externally modified:
			 *
			 * app.vault.on('modify')
			 * app.workspace.on('editor-change')
			 *
			 * This apparently causes issues for people with iCloud, as Obsidian is constantly
			 * firing these events when files sync.
			 *
			 * See this comment: https://forum.obsidian.md/t/51776/20
			 * And this thread: https://forum.obsidian.md/t/14874
			 *
			 * The way I am doing this is probably a "bad" way. Anyone who knows the best practice
			 * here, please let me know! It works just fine but perhaps there's a better way.
			 */
			this.registerDomEvent(document, 'keyup', ev => {
				// Check to see if the inputted key is a single, visible Unicode character.
				// This is to prevent matching arrow keys, etc. Using Unicode is necessary
				// to match on emoji and other 2-byte characters.
				if (!ev.ctrlKey && !ev.altKey && !ev.metaKey && /^.$/u.test(ev.key)) {
				  try {
					// Check to see if the typing event was in the editor DOM element
					// @ts-ignore
					if (ev.target.closest('.markdown-source-view .cm-editor')) {
					  // Find the active TFile inside the editor view
					  // @ts-ignore
					  this.updateFrontmatter(ev.view.app.workspace.activeEditor.file)
					}
				  } catch (e) { }
				}
			  })
		}

		this.addSettingTab(new FrontmatterModifiedSettingTab(this.app, this));
		this.addCommand({
			id: "tab-copy-url",
			name: "Tab-Copy for Advanced URL",
			callback: () => {
				console.log("Tab-Copy for Advanced URL");
				// 获取当前vault的名称
				const vaultName = this.app.vault.getName();
				// 获取当前文件
				const activeFile = this.app.workspace.getActiveFile();
				if (activeFile) {
					this.app.fileManager.processFrontMatter(activeFile, (frontmatter) => {
						frontmatter[this.settings.uuidProperty] = uuidv4();
						// const frontmatter = this.app.metadataCache.getFileCache(
						// 	activeFile
						// )?.frontmatter;
						var uuid=frontmatter[this.settings.uuidProperty];
						const title=activeFile.basename
						if(!uuid){
							console.log("uuid不存在,新建一个	");
							uuid = uuidv4();
							frontmatter[this.settings.uuidProperty] = uuid;
						}
						const url = `obsidian://advanced-uri?vault=${vaultName}&uid=${uuid}`
						console.log(url);
						const link=`[${title}](${url} )`
						navigator.clipboard.writeText(link);
					});
					
				}
			}
		});

		//添加一个Command,用于手动更新frontmatter
		this.addCommand({
			id: "update-frontmatter",
			name: "Update Frontmatter",
			callback: () => {
				const activeFile = this.app.workspace.getActiveFile();
				if (activeFile) {
					this.realUpdateFrontmatter(activeFile);
				}
			}
		});	
		
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async realUpdateFrontmatter(file: TFile) {
		console.log("realUpdateFrontmatter",file.path);
		const cache = this.app.metadataCache.getFileCache(file);
			if (
				this.settings.onlyUpdateExisting &&
				!cache?.frontmatter?.hasOwnProperty(
					this.settings.updatedProperty
				)
			) {
				// The user has chosen to only update the frontmatter property IF it already exists
			} else if (cache?.frontmatter?.[this.settings.excludeField]) {
				// This file has been excluded by YAML field
			} else if (
				this.settings.excludedFolders.some((folder) =>
					file.path.startsWith(folder + "/")
				)
			) {
				// This folder is in the exclusion list
			} else {
				this.app.fileManager.processFrontMatter(file, (frontmatter) => {
					// Update the frontmatter field
					//
					// We will only update if it's been more than 30 seconds since the last recorded time. We do this
					// as a preventative measure against a race condition where two devices have the same note open
					// and are both syncing and updating each other.
					const now = moment();
					// Are we appending to an array of entries?
					const isAppendArray =
						frontmatter[this.settings.appendField] === true;
					let secondsSinceLastUpdate = Infinity;
					let previousEntryMoment;
					if (frontmatter[this.settings.updatedProperty]) {
						let previousEntry =
							frontmatter[this.settings.updatedProperty];
						if (isAppendArray && Array.isArray(previousEntry)) {
							// If we are using an array of updates, get the last item in the list
							previousEntry =
								previousEntry[previousEntry.length - 1];
						}
						// Get the length of time since the last update. Use a strict moment
						previousEntryMoment = moment(
							previousEntry,
							this.settings.momentFormat,
							true
						);
						if (previousEntryMoment.isValid()) {
							secondsSinceLastUpdate = now.diff(
								previousEntryMoment,
								"seconds"
							);
						}
					}
					if (secondsSinceLastUpdate > 30) {
						let newEntry: string | string[] = now.format(
							this.settings.momentFormat
						);
						if (isAppendArray) {
							let entries =
								frontmatter[
									this.settings.updatedProperty
								] || [];
							if (!Array.isArray(entries)) entries = [entries];
							// We are using an array of entries. We need to check whether we want to replace the last array
							// entry (e.g. it is within the same timeframe unit), or we want to append a new entry
							if (entries.length && previousEntryMoment) {
								if (
									now.isSame(
										previousEntryMoment,
										this.settings.appendMaximumFrequency
									)
								) {
									// Same timeframe as the previous entry - replace it
									entries[entries.length - 1] = newEntry;
								} else {
									entries.push(newEntry);
								}
							} else {
								// No existing entries, push the new entry
								entries.push(newEntry);
							}
							newEntry = entries;
						}
						console.log("准备更新frontmatter");
						console.log(frontmatter);
						//自动添加tiltle属性,值为文件名,方便hugo使用
						frontmatter["title"] = file.basename
						// 自动添加aliases属性,默认值为空数组,方便hugo使用
						const aliases:string[] = frontmatter["aliases"];
						console.log(aliases);
						if (!aliases) {
							frontmatter["aliases"] = [];
						}
						// 自动添加tags属性,值为空数组,方便hugo使用
						const fileCache = this.app.metadataCache.getFileCache(file);
						const fileCacheTags = fileCache?.tags || [];
						console.log("fileCacheTags: ",fileCacheTags);
						let tags:TagCache[]=[]
						if (fileCacheTags) {
							console.log("fileCache存在,更新tags");
							tags =fileCacheTags
						}else{
							console.log("fileCache不存在,新建tags");
							tags = []
						}
						console.log("tags: ",tags); 
						
						// 更新创建时间的逻辑
						const createdTime =
							frontmatter[this.settings.createdProperty];
						if (!createdTime) {
							frontmatter[this.settings.createdProperty] = moment(
								file.stat.ctime
							).format(this.settings.momentFormat);
						}
						//更像updatedProperty
						frontmatter[this.settings.updatedProperty] =newEntry;
						// 更新uuid的逻辑
						const uuid = frontmatter[this.settings.uuidProperty];
						if (!uuid) {
							frontmatter[this.settings.uuidProperty] = uuidv4();
						}
						//自动添加slug属性,值为uuid的值,方便hugo使用
						const slug = frontmatter[this.settings.slugProperty];
						console.log(slug);
						if (!slug) {
							frontmatter[this.settings.slugProperty] = frontmatter[this.settings.uuidProperty]
						}
						//自动添加obsidianLink属性,方便hugo使用
						const obsidianLink = frontmatter["obsidianLink"];
						console.log(obsidianLink);
						if (!obsidianLink) {
							frontmatter["obsidianLink"] = `obsidian://advanced-uri?vault=note&uid=${frontmatter[this.settings.uuidProperty]}`
						}
						// 自动添加hugoLink属性,方便hugo使用
						const hugoLink = frontmatter["hugoLink"];
						console.log(hugoLink);
						if (!hugoLink) {
							frontmatter["hugoLink"] = `https://blog.fishyer.com/post/${frontmatter[this.settings.uuidProperty]}/`
						}
						//自动添加zhihu-tags属性,值为tags的值,方便zhihu插件使用
						const obsidian_tags = this.getStringTags(tags);
						console.log("obsidian_tags: ",obsidian_tags);
						frontmatter["tags"] = obsidian_tags
						const zhihu_tags = this.getStringTags(tags);
						console.log("zhihu_tags: ",zhihu_tags);
						frontmatter[this.settings.zhihuTagsProperty] =zhihu_tags
						// const published = frontmatter["published"];
						// if (!published) {
						// 	// 默认发布
						// 	frontmatter["published"] = "true";
						// }
						// const dateProperty = frontmatter["date"];
						// if (!dateProperty) {
						// 	frontmatter["date"] = moment(
						// 		file.stat.ctime
						// 	).format(this.settings.momentFormat);
						// }
						// console.log(JSON.stringify(file));
					}
				});
			}

	}

	/**
	 * Use a timeout to update the metadata only once the user has stopped typing.
	 * If the user keeps typing, then it will reset the timeout and start again from zero.
	 *
	 * Obsidian doesn't appear to correctly handle this situation otherwise, and pops an
	 * error to say "<File> has been modified externally, merging changes automatically."
	 *
	 * @param {TFile} file
	 */
	async updateFrontmatter(file: TFile) {
		console.log("updateFrontmatter",file.path);
		clearTimeout(this.timer[file.path]);
		this.timer[file.path] = window.setTimeout(() => {
			this.realUpdateFrontmatter(file);
		}, this.settings.timeout * 1000);
	}

	// 写一个拷贝字符串数组的函数
	 getStringTags(tags: TagCache[]): string[] {
		const tagsArray:string[] = tags.map((tag) => tag.tag.replace("#", ""));
		// // 新建一个数组
		// let newArr = [];
		// // 遍历原数组
		// for (let i = 0; i < tagsArray.length; i++) {
		// 	newArr[i] = tagsArray[i];
		// }
		return tagsArray;
	}
	
}

class FrontmatterModifiedSettingTab extends PluginSettingTab {
	plugin: FrontmatterModified;

	constructor(app: App, plugin: FrontmatterModified) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		// Frontmatter property setting
		new Setting(containerEl)
			.setName("Frontmatter property for updated time")
			.setDesc("The name of the YAML/frontmatter property to update")
			.addText((text) =>
				text
					.setPlaceholder("updated_at")
					.setValue(this.plugin.settings.updatedProperty)
					.onChange(async (value) => {
						this.plugin.settings.updatedProperty = value;
						await this.plugin.saveSettings();
					})
			);

		// 添加对创建时间的设置
		new Setting(containerEl)
			.setName("Frontmatter property for created time")
			.setDesc(
				"The name of the YAML/frontmatter property to store the created time"
			)
			.addText((text) =>
				text
					.setPlaceholder("created_at")
					.setValue(this.plugin.settings.createdProperty)
					.onChange(async (value) => {
						this.plugin.settings.createdProperty = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Frontmatter property for uuid_name")
			.setDesc(
				"The name of the YAML/frontmatter property to store the uuid_name"
			)
			.addText((text) =>
				text
					.setPlaceholder("uuid_name")
					.setValue(this.plugin.settings.uuidProperty)
					.onChange(async (value) => {
						this.plugin.settings.uuidProperty = value;
						await this.plugin.saveSettings();
					})
			);
		
		new Setting(containerEl)
			.setName("Frontmatter property for slug_name")
			.setDesc(
				"The name of the YAML/frontmatter property to store the slug_name"
			)
			.addText((text) =>
				text
					.setPlaceholder("slug_name")
					.setValue(this.plugin.settings.slugProperty)
					.onChange(async (value) => {
						this.plugin.settings.slugProperty = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Frontmatter property for zhihu-tags")
			.setDesc(
				"The name of the YAML/frontmatter property to store the zhihu-tags"
			)
			.addText((text) =>
				text
					.setPlaceholder("zhihu-tags")
					.setValue(this.plugin.settings.zhihuTagsProperty)
					.onChange(async (value) => {
						this.plugin.settings.zhihuTagsProperty = value;
						await this.plugin.saveSettings();
					})
			);

		// Date format setting
		new Setting(containerEl)
			.setName("Date format")
			.setDesc(
				"This is in MomentJS format. Leave blank for the default ATOM format."
			)
			.addText((text) =>
				text
					.setPlaceholder("ATOM format")
					.setValue(this.plugin.settings.momentFormat)
					.onChange(async (value) => {
						this.plugin.settings.momentFormat = value;
						await this.plugin.saveSettings();
					})
			);

		// Exclude folders
		new Setting(containerEl)
			.setName("Exclude folders")
			.setDesc(
				"Add a list of folders to exclude, one folder per line. All subfolders will be also excluded."
			)
			.addTextArea((text) =>
				text
					.setValue(this.plugin.settings.excludedFolders.join("\n"))
					.onChange(async (value) => {
						this.plugin.settings.excludedFolders = value
							.split("\n")
							.map((x) => x.trim())
							.filter((x) => !!x);
						await this.plugin.saveSettings();
					})
			);

		// Update existing fields toggle
		new Setting(containerEl)
			.setName("Only update existing fields")
			.setDesc(
				"If you turn this on, it will only update a frontmatter field *if that field already exists*."
			)
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.onlyUpdateExisting)
					.onChange(async (value) => {
						this.plugin.settings.onlyUpdateExisting = value;
						await this.plugin.saveSettings();
					});
			});

		// Use typing events toggle
		new Setting(containerEl)
			.setName("Use typing events instead of Obsidian events")
			.setDesc(
				`If you make changes to a file using an external editor and Obsidian is currently open, Obsidian
will register this as a modification and update the frontmatter. If you don't want this to happen, and only
want the frontmatter when you are making changes inside Obsidian, you can try this mode. It watches for typing 
events, and then updates the frontmatter only when you type. This means that some events like updating your note 
or properties using your mouse will not cause the modified field to update. You will need to restart Obsidian 
after this change.`
			)
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.useKeyupEvents)
					.onChange(async (value) => {
						this.plugin.settings.useKeyupEvents = value;
						await this.plugin.saveSettings();
					});
			});
	}
}
