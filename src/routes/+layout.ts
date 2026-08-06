/**
 * SvelteKit 全域客戶端載入器 (Layout Client Load)
 * 
 * 職責：
 * 1. 初始化客戶端專用的追蹤與分析工具。
 * 2. 注入 Vercel Speed Insights 以追蹤頁面效能。
 */
import { injectSpeedInsights } from '@vercel/speed-insights/sveltekit';

// 初始化 Vercel Speed Insights
injectSpeedInsights();
