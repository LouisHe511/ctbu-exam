/**
 * 真题库的「界面状态」暂存（不是业务数据）。
 *
 * 为什么需要：页面状态放在组件里，一旦跳去阅读器再回来，组件重建 → 筛选、视图模式、
 * 滚动位置全丢，用户会发现自己被扔回「按课程」或列表顶部。用户明确提过这个毛病：
 * 「从按试卷进去，返回却到了课程页，我要回到刚才那个页面」。
 *
 * 做法：模块级单例（不是 localStorage）——
 *   · 同一个 tab 内前进后退、进阅读器再回来，状态都在；
 *   · 重新打开网站时回到干净的默认值，不会把上次的筛选项莫名其妙带进来。
 * 只存 UI 偏好，不存数据；数据始终走 PapersContext。
 */
export type LibraryViewMode = 'papers' | 'courses';
export type LibrarySort = 'latest' | 'views' | 'year_desc';

export interface LibraryUIState {
  viewMode: LibraryViewMode;
  category?: string;
  year: string;
  semester: string;
  examType: string;
  term: string;
  hasAnswer: string;
  hasSolution: string;
  sortBy: LibrarySort;
  search: string;
  onlyWithPapers: boolean;
  showFilters: boolean;
  scrollY: number;
}

const DEFAULTS: LibraryUIState = {
  viewMode: 'papers',
  category: undefined,
  year: 'all',
  semester: 'all',
  examType: 'all',
  term: 'all',
  hasAnswer: 'all',
  hasSolution: 'all',
  sortBy: 'latest',
  search: '',
  onlyWithPapers: false,
  showFilters: false,
  scrollY: 0,
};

let state: LibraryUIState = { ...DEFAULTS };

export function readLibraryState(): LibraryUIState {
  return { ...state };
}

export function patchLibraryState(patch: Partial<LibraryUIState>): void {
  state = { ...state, ...patch };
}

/** 用户点「清除筛选」时连暂存一起清，避免下次进来又看到旧条件 */
export function resetLibraryState(): void {
  state = { ...DEFAULTS, viewMode: state.viewMode, scrollY: 0 };
}
