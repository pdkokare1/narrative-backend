// services/gamificationService.ts
import Profile, { IProfile, IQuest } from '../models/profileModel';
import UserStats from '../models/userStatsModel';
import { IBadge } from '../types';

class GamificationService {
    
    // --- 1. Streak Logic (With Freezes & Timezones) ---
    async updateStreak(userId: string, timezone: string = 'UTC'): Promise<IBadge | null> {
        const profile = await Profile.findOne({ userId });
        if (!profile) return null;

        const now = new Date();
        const lastActive = profile.lastActiveDate ? new Date(profile.lastActiveDate) : new Date(0);
        
        // Normalize to USER's midnight
        const userTodayString = now.toLocaleString('en-US', { timeZone: timezone }).split(',')[0];
        const userLastDateString = lastActive.toLocaleString('en-US', { timeZone: timezone }).split(',')[0];

        const todayDate = new Date(userTodayString).getTime();
        const lastDate = new Date(userLastDateString).getTime();
        
        const oneDay = 24 * 60 * 60 * 1000;
        const diffTime = todayDate - lastDate;
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
            
            if (profile.streakFreezes >= missedDays) {
                profile.streakFreezes -= missedDays;
                profile.currentStreak += 1; 
            } else {
                profile.currentStreak = 1; 
            }
        } else {
             profile.currentStreak = 1;
        }

        profile.lastActiveDate = now;
        await profile.save();
        
        const streakBadge = await this.checkStreakBadges(profile);
        this.checkPerspectiveBadge(userId);
        this.checkReadBadges(userId);

        // NEW: Check/Generate Quests on new day
        await this.checkDailyQuests(profile, timezone);

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

    // Updated to use TRUE READ count from UserStats
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

    // --- 4. NEW: Quest System Engine ---
    
    // A. Generate Daily Quests
    async checkDailyQuests(profile: IProfile, timezone: string) {
        try {
            const now = new Date();
            const quests = profile.quests || [];
            
            // Check if quests are expired
            const hasActiveQuests = quests.some(q => new Date(q.expiresAt) > now && !q.isCompleted);
            
            if (!hasActiveQuests) {
                // Generate new quests
                const newQuests = await this.generateQuests(profile.userId);
                
                // Set expiry to end of day in user timezone
                // Simplified: Set to 24 hours from now for robustness
                const expiry = new Date(now.getTime() + 24 * 60 * 60 * 1000); 
                
                profile.quests = newQuests.map(q => ({ ...q, expiresAt: expiry }));
                await profile.save();
            }
        } catch (error) {
            console.error('Quest Gen Error:', error);
        }
    }

    // B. Create specific quests based on user needs
    private async generateQuests(userId: string): Promise<any[]> {
        const stats = await UserStats.findOne({ userId });
        const quests = [];

        // Quest 1: Deep Reading (Standard)
        quests.push({
            id: `daily_deep_${Date.now()}`,
            type: 'read_deep',
            target: 1,
            progress: 0,
            isCompleted: false,
            reward: 'xp',
            description: 'Read 1 article deeply (spend > 2 mins).'
        });

        // Quest 2: Echo Chamber Breaker (Smart)
        if (stats) {
            const left = stats.leanExposure?.Left || 0;
            const right = stats.leanExposure?.Right || 0;
            
            let targetBias = '';
            if (left > right * 2) targetBias = 'Right';
            if (right > left * 2) targetBias = 'Left';

            if (targetBias) {
                quests.push({
                    id: `daily_bridge_${Date.now()}`,
                    type: 'read_opposing',
                    target: 1,
                    progress: 0,
                    isCompleted: false,
                    reward: 'streak_freeze',
                    description: `Read 1 article from a ${targetBias}-leaning source.`
                });
            } else {
                 quests.push({
                    id: `daily_explore_${Date.now()}`,
                    type: 'topic_explorer',
                    target: 3,
                    progress: 0,
                    isCompleted: false,
                    reward: 'xp',
                    description: 'Read articles from 3 different categories.'
                });
            }
        }

        return quests;
    }

    // C. Update Progress
    async processQuestEvent(userId: string, eventType: string, data: any) {
        try {
            const profile = await Profile.findOne({ userId });
            if (!profile || !profile.quests) return;

            let updated = false;

            for (const quest of profile.quests) {
                if (quest.isCompleted || new Date() > new Date(quest.expiresAt)) continue;

                if (quest.type === 'read_deep' && eventType === 'true_read') {
                    if (data.duration > 120) {
                        quest.progress++;
                        updated = true;
                    }
                }
                
                if (quest.type === 'read_opposing' && eventType === 'read_article') {
                    // Check if article lean matches target description
                    const targetLean = quest.description.includes('Left') ? 'Left' : 'Right';
                    const articleLean = data.lean; // 'Left', 'Right', 'Center'
                    
                    if (articleLean === targetLean) {
                        quest.progress++;
                        updated = true;
                    }
                }
                
                 if (quest.type === 'topic_explorer' && eventType === 'read_article') {
                    // Simplified: Just count reads for now
                    quest.progress++;
                    updated = true;
                }

                // Check Completion
                if (quest.progress >= quest.target) {
                    quest.isCompleted = true;
                    // Grant Reward
                    if (quest.reward === 'streak_freeze') {
                        profile.streakFreezes = (profile.streakFreezes || 0) + 1;
                    }
                }
            }

            if (updated) await profile.save();

        } catch (error) {
            console.error('Quest Update Error:', error);
        }
    }
}

export = new GamificationService();
