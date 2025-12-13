// services/gamificationService.ts
import Profile from '../models/profileModel';
import Article from '../models/articleModel';
import { IUserProfile, IBadge } from '../types';

class GamificationService {
    
    // --- 1. Streak Logic ---
    async updateStreak(userId: string): Promise<void> {
        const profile = await Profile.findOne({ userId });
        if (!profile) return;

        const now = new Date();
        const lastActive = profile.lastActiveDate ? new Date(profile.lastActiveDate) : new Date(0);
        
        // Normalize to midnight to compare "days"
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        const lastDate = new Date(lastActive.getFullYear(), lastActive.getMonth(), lastActive.getDate()).getTime();
        const oneDay = 24 * 60 * 60 * 1000;

        // A. Same day activity? Do nothing.
        if (today === lastDate) {
            return;
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
        await this.checkStreakBadges(profile);
    }

    // --- 2. Badge Logic ---
    async checkStreakBadges(profile: any) {
        const streakBadges = [
            { id: 'streak_3', label: '3 Day Streak', threshold: 3, icon: '🔥' },
            { id: 'streak_7', label: 'Week Warrior', threshold: 7, icon: '⚔️' },
            { id: 'streak_30', label: 'Monthly Master', threshold: 30, icon: '👑' }
        ];

        let badgeAwarded = false;
        for (const badge of streakBadges) {
            if (profile.currentStreak >= badge.threshold) {
                const hasBadge = profile.badges.some((b: IBadge) => b.id === badge.id);
                if (!hasBadge) {
                    profile.badges.push({
                        id: badge.id,
                        label: badge.label,
                        icon: badge.icon,
                        description: `Maintained a ${badge.threshold} day reading streak.`,
                        earnedAt: new Date()
                    });
                    badgeAwarded = true;
                    console.log(`🏆 Badge Awarded: ${badge.label}`);
                }
            }
        }
        if (badgeAwarded) await profile.save();
    }

    async checkReadBadges(userId: string) {
        const profile = await Profile.findOne({ userId });
        if (!profile) return;

        // Example: "The Centrist" (Read 5 Left and 5 Right articles)
        // We would need to query the ActivityLog or keep counters. 
        // For efficiency, we will use the existing counters on the profile.
        
        const count = profile.articlesViewedCount;
        
        const viewBadges = [
            { id: 'reader_10', label: 'Informed', threshold: 10, icon: '📰' },
            { id: 'reader_50', label: 'Well Read', threshold: 50, icon: '📚' },
            { id: 'reader_100', label: 'News Junkie', threshold: 100, icon: '🧠' }
        ];

        let badgeAwarded = false;
        for (const badge of viewBadges) {
            if (count >= badge.threshold) {
                if (!profile.badges.some((b: IBadge) => b.id === badge.id)) {
                    profile.badges.push({
                        id: badge.id,
                        label: badge.label,
                        icon: badge.icon,
                        description: `Read ${badge.threshold} articles.`,
                        earnedAt: new Date()
                    });
                    badgeAwarded = true;
                }
            }
        }
        if (badgeAwarded) await profile.save();
    }
}

export = new GamificationService();
