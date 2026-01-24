// services/gamificationService.ts
import Profile from '../models/profileModel';
import UserStats from '../models/userStatsModel';
import { IBadge } from '../types';

class GamificationService {
    
    // --- 1. Streak Logic ---
    async updateStreak(userId: string): Promise<IBadge | null> {
        const profile = await Profile.findOne({ userId });
        if (!profile) return null;

        const now = new Date();
        const lastActive = profile.lastActiveDate ? new Date(profile.lastActiveDate) : new Date(0);
        
        // Normalize to midnight to compare "days"
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        const lastDate = new Date(lastActive.getFullYear(), lastActive.getMonth(), lastActive.getDate()).getTime();
        const oneDay = 24 * 60 * 60 * 1000;

        // A. Same day activity? Do nothing.
        if (today === lastDate) {
            return null;
        }

        // B. Consecutive day? Increment.
        if (today - lastDate === oneDay) {
            profile.currentStreak += 1;
            console.log(`🔥 Streak Incremented for ${profile.username}: ${profile.currentStreak}`);
        } 
        // C. Missed a day? Reset.
        else {
            // Only reset if it's not the very first activity
            if (profile.lastActiveDate) {
                profile.currentStreak = 1;
                console.log(`❄️ Streak Reset for ${profile.username}`);
            } else {
                profile.currentStreak = 1; // First ever action
            }
        }

        profile.lastActiveDate = now;
        await profile.save();
        
        // Check for Streak Badges
        const streakBadge = await this.checkStreakBadges(profile);
        
        // Check for Perspective Badge (Async, don't block)
        this.checkPerspectiveBadge(userId);

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
                    console.log(`🏆 Badge Awarded: ${badge.label}`);
                }
            }
        }
        
        if (awardedBadge) await profile.save();
        return awardedBadge;
    }

    async checkReadBadges(userId: string): Promise<IBadge | null> {
        const profile = await Profile.findOne({ userId });
        if (!profile) return null;

        const count = profile.articlesViewedCount;
        
        const viewBadges = [
            { id: 'reader_10', label: 'Informed', threshold: 10, icon: '📰' },
            { id: 'reader_50', label: 'Well Read', threshold: 50, icon: '📚' },
            { id: 'reader_100', label: 'News Junkie', threshold: 100, icon: '🧠' }
        ];

        let awardedBadge: IBadge | null = null;

        for (const badge of viewBadges) {
            if (count >= badge.threshold) {
                if (!profile.badges.some((b: IBadge) => b.id === badge.id)) {
                    awardedBadge = {
                        id: badge.id,
                        label: badge.label,
                        icon: badge.icon,
                        description: `Read ${badge.threshold} articles.`,
                        earnedAt: new Date()
                    };
                    profile.badges.push(awardedBadge);
                }
            }
        }
        
        if (awardedBadge) await profile.save();
        return awardedBadge;
    }

    // --- 3. Perspective Hunter Badge ---
    // Rewards users for reading across the political spectrum
    async checkPerspectiveBadge(userId: string): Promise<void> {
        try {
            const stats = await UserStats.findOne({ userId });
            if (!stats) return;

            // Threshold: 10 minutes (600 seconds) on BOTH sides
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
                    console.log(`🏆 Badge Awarded: Perspective Hunter for ${userId}`);
                }
            }
        } catch (err) {
            console.error('Error checking perspective badge:', err);
        }
    }
}

export = new GamificationService();
