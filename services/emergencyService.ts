// services/emergencyService.ts
import EmergencyContact from '../models/emergencyContactModel';
import { emergencyData } from './emergencyData';

// Main Logic: Initialize Database if Empty
async function initializeEmergencyContacts() {
  try {
    const count = await EmergencyContact.countDocuments();
    if (count === 0) {
      console.log('🚑 Seeding Emergency Contacts...');
      await EmergencyContact.insertMany(emergencyData);
      console.log('✅ Emergency Contacts Seeded Successfully');
    }
  } catch (error) {
    console.error('❌ Error Seeding Contacts:', error);
  }
}

// Fetch Contacts with filtering
interface FilterParams {
    scope?: string;
    country?: string;
}

async function getContacts(filters: FilterParams = {}) {
    const query: any = {};
    if (filters.scope && filters.scope !== 'All') {
        query.scope = filters.scope;
    }
    if (filters.country) {
        query.country = filters.country;
    }
    return await EmergencyContact.find(query).sort({ category: 1, serviceName: 1 }).lean();
}

export default {
  initializeEmergencyContacts,
  getContacts
};
