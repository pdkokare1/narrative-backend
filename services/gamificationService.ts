// services/gamificationService.ts
import Profile from '../models/profileModel';
import UserStats from '../models/userStatsModel';
import { IBadge } from '../types';

class GamificationService {
    
    // --- 1. Streak Logic (With Freezes) ---
    async updateStreak(userId: string): Promise<IBadge | null> {
        const profile = await Profile.findOne({ userId });
        if (!profile) return null;

        const now = new Date();
        const lastActive = profile.lastActiveDate ? new Date(profile.lastActiveDate) : new Date(0);
        
        // Normalize to midnight
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        const lastDate = new Date(lastActive.getFullYear(), lastActive.getMonth(), lastActive.getDate()).getTime();
        const oneDay = 24 * 60 * 60 * 1000;

        const diffTime = today - lastDate;
        const diffDays = Math.round(diffTime / oneDay);

        // A. Same day? Do nothing.
        if (diffDays === 0) {
            return null;
        }

        // B. Consecutive day? Increment.
        if (diffDays === 1) {
            profile.currentStreak += 1;
        } 
        // C. Missed days? Check Freezes.
        else if (diffDays > 1) {
            const missedDays = diffDays - 1;
            
            // Do they have enough freezes to cover the gap?
            if (profile.streakFreezes >= missedDays) {
                profile.streakFreezes -= missedDays;
                // We DON'T reset. We increment because they are active today.
                // It effectively "stitches" the gap.
                profile.currentStreak += 1; 
            } else {
                // Not enough freezes -> Reset
                profile.currentStreak = 1; 
            }
        } else {
             // Should not happen (diffDays < 0), but safety fallback
             profile.currentStreak = 1;
        }

        profile.lastActiveDate = now;
        await profile.save();
        
        // Check for Streak Badges
        const streakBadge = await this.checkStreakBadges(profile);
        
        // Check for Perspective Badge (Async)
        this.checkPerspectiveBadge(userId);

        // NEW: Check for Reader Badges (Async)
        this.checkReadBadges(userId);

        return streakBadge;
    }

    // --- 2. Badge Logic ---
    async checkStreakBadges(profile: any): Promise<IBadge | null> {
        const streakBadges = [
            { id: 'streak_3', label: '3 Day Streak', threshold: 3, icon: '🔥' },
            { id: 'streak_7', label: 'Week Warrior', threshold: 7, icon: '⚔️' },
            { id: 'streak_30', label: 'Monthly Master', threshold: 30, icon: '👑' }
        ];

        let awardedBadge: IBadge | null = null;

        for (const badge of streakBadges) {
            if (profile.currentStreak >= badge.threshold) {
                const hasBadge = profile.badges.some((b: IBadge) => b.id === badge.id);
                if (!hasBadge) {
                    awardedBadge = {
                        id: badge.id,
                        label: badge.label,
                        icon: badge.icon,
                        description: `Maintained a ${badge.threshold} day reading streak.`,
                        earnedAt: new Date()
                    };
                    profile.badges.push(awardedBadge);
                }
            }
        }
        
        if (awardedBadge) await profile.save();
        return awardedBadge;
    }

    // NEW: Updated to use TRUE READ count from UserStats
    async checkReadBadges(userId: string): Promise<IBadge | null> {
        const profile = await Profile.findOne({ userId });
        const stats = await UserStats.findOne({ userId });
        
        if (!profile || !stats) return null;

        const count = stats.articlesReadCount || 0;
        const avgSpan = stats.averageAttentionSpan || 0;
        
        const viewBadges = [
            { id: 'reader_10', label: 'Informed', threshold: 10, icon: '📰', desc: 'Read 10 full articles.' },
            { id: 'reader_50', label: 'Well Read', threshold: 50, icon: '📚', desc: 'Read 50 full articles.' },
            { id: 'reader_100', label: 'News Junkie', threshold: 100, icon: '🧠', desc: 'Read 100 full articles.' }
        ];

        let awardedBadge: IBadge | null = null;
        let profileChanged = false;

        // A. Check Volume Badges
        for (const badge of viewBadges) {
            if (count >= badge.threshold) {
                if (!profile.badges.some((b: IBadge) => b.id === badge.id)) {
                    awardedBadge = {
                        id: badge.id,
                        label: badge.label,
                        icon: badge.icon,
                        description: badge.desc,
                        earnedAt: new Date()
                    };
                    profile.badges.push(awardedBadge);
                    profileChanged = true;
                }
            }
        }

        // B. Check Attention/Quality Badge (Deep Diver)
        // 180 seconds = 3 minutes average attention span
        if (avgSpan > 180 && count > 5) {
             if (!profile.badges.some((b: IBadge) => b.id === 'deep_diver')) {
                const deepBadge = {
                    id: 'deep_diver',
                    label: 'Deep Diver',
                    icon: '🌊',
                    description: 'Average attention span over 3 minutes.',
                    earnedAt: new Date()
                };
                profile.badges.push(deepBadge);
                profileChanged = true;
                if (!awardedBadge) awardedBadge = deepBadge;
             }
        }
        
        if (profileChanged) await profile.save();
        return awardedBadge;
    }

    // --- 3. Perspective Hunter Badge ---
    async checkPerspectiveBadge(userId: string): Promise<void> {
        try {
            const stats = await UserStats.findOne({ userId });
            if (!stats) return;

            const THRESHOLD = 600; 

            const left = stats.leanExposure?.Left || 0;
            const right = stats.leanExposure?.Right || 0;

            if (left > THRESHOLD && right > THRESHOLD) {
                const profile = await Profile.findOne({ userId });
                if (profile && !profile.badges.some((b: IBadge) => b.id === 'perspective_hunter')) {
                    const newBadge = {
                        id: 'perspective_hunter',
                        label: 'Perspective Hunter',
                        icon: '⚖️',
                        description: 'Read over 10 mins of both Left and Right perspectives.',
                        earnedAt: new Date()
                    };
                    profile.badges.push(newBadge);
                    await profile.save();
                }
            }
        } catch (err) {
            console.error('Error checking perspective badge:', err);
        }
    }
}

export = new GamificationService();
