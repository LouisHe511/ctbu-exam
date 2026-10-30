import type { UserProfile, UserDevice, UserPermission, UserFavorite, RecentView } from '@/types';

export const currentUser: UserProfile = {
  id: 'u001',
  name: '张明轩',
  email: 'zhangmx@ctbu.edu.cn',
  avatar: '',
  studentId: '2022031501',
  school: '重庆工商大学',
  college: '经济学院',
  joinedAt: '2022-09-01',
};

export const userDevices: UserDevice[] = [
  { id: 'd001', deviceName: 'iPhone 15 Pro', deviceType: '手机', lastActive: '2024-12-20 10:30', isCurrent: true },
  { id: 'd002', deviceName: 'MacBook Air M2', deviceType: '电脑', lastActive: '2024-12-19 22:15', isCurrent: false },
  { id: 'd003', deviceName: 'iPad Air', deviceType: '平板', lastActive: '2024-12-18 14:20', isCurrent: false },
];

export const userPermissions: UserPermission[] = [
  { courseId: 'c001', courseName: '微观经济学', purchasedAt: '2024-09-01', expiresAt: '2025-09-01', status: 'active' },
  { courseId: 'c003', courseName: '货币银行学', purchasedAt: '2024-09-15', expiresAt: '2025-09-15', status: 'active' },
  { courseId: 'c008', courseName: '中级财务会计', purchasedAt: '2024-10-01', expiresAt: '2025-10-01', status: 'active' },
  { courseId: 'c011', courseName: '概率论与数理统计', purchasedAt: '2023-09-01', expiresAt: '2024-09-01', status: 'expired' },
  { courseId: 'c014', courseName: '大学英语', purchasedAt: '2024-09-01', expiresAt: '2025-09-01', status: 'active' },
];

export const userFavorites: UserFavorite[] = [
  { paperId: 'p0001', addedAt: '2024-12-15T10:30:00.000Z' },
  { paperId: 'p0008', addedAt: '2024-12-14T14:20:00.000Z' },
  { paperId: 'p0015', addedAt: '2024-12-10T09:00:00.000Z' },
  { paperId: 'p0022', addedAt: '2024-12-08T16:45:00.000Z' },
  { paperId: 'p0030', addedAt: '2024-12-05T11:15:00.000Z' },
];

export const recentViews: RecentView[] = [
  { paperId: 'p0001', viewedAt: '2024-12-20 10:25' },
  { paperId: 'p0003', viewedAt: '2024-12-20 09:15' },
  { paperId: 'p0008', viewedAt: '2024-12-19 22:00' },
  { paperId: 'p0015', viewedAt: '2024-12-19 20:30' },
  { paperId: 'p0022', viewedAt: '2024-12-18 14:10' },
  { paperId: 'p0030', viewedAt: '2024-12-17 16:45' },
  { paperId: 'p0035', viewedAt: '2024-12-17 11:20' },
  { paperId: 'p0042', viewedAt: '2024-12-16 19:00' },
];
