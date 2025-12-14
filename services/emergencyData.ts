// services/emergencyData.ts
import { IEmergencyContact } from '../types';

export const emergencyData: Partial<IEmergencyContact>[] = [
  {
    category: "Primary Emergency",
    serviceName: "Unified Emergency Response System",
    description: "Single number for all emergencies",
    number: "112",
    scope: "All India",
    hours: "24×7",
    country: "India"
  },
  {
    category: "Primary Emergency",
    serviceName: "Police",
    description: "Crime reporting, emergency assistance",
    number: "100 or 112",
    scope: "All India",
    hours: "24×7",
    country: "India"
  },
  {
    category: "Primary Emergency",
    serviceName: "Fire & Rescue",
    description: "Fire emergencies, rescue operations",
    number: "101 or 112",
    scope: "All India",
    hours: "24×7",
    country: "India"
  },
  {
    category: "Primary Emergency",
    serviceName: "Ambulance Services",
    description: "Medical emergency, patient transport",
    number: "102 or 108",
    scope: "All India",
    hours: "24×7",
    country: "India"
  },
  {
    category: "Primary Emergency",
    serviceName: "Disaster Management",
    description: "Natural disasters, calamities",
    number: "108 or 1078",
    scope: "All India",
    hours: "24×7",
    country: "India"
  },
  {
    category: "Women & Child Safety",
    serviceName: "National Women Helpline",
    description: "Domestic abuse, violence, harassment",
    number: "1091",
    scope: "All India",
    hours: "24×7",
    country: "India"
  },
  {
    category: "Women & Child Safety",
    serviceName: "Women Helpline - Domestic Abuse",
    description: "Domestic violence support",
    number: "181",
    scope: "All India",
    hours: "24×7",
    country: "India"
  },
  {
    category: "Women & Child Safety",
    serviceName: "NCW Women Helpline",
    description: "Violence against women, discrimination",
    number: "14490",
    scope: "All India",
    hours: "24×7",
    country: "India"
  },
  {
    category: "Women & Child Safety",
    serviceName: "National Child Helpline",
    description: "Child abuse, trafficking, rescue",
    number: "1098",
    scope: "All India",
    hours: "24×7",
    country: "India"
  },
  {
    category: "Women & Child Safety",
    serviceName: "Missing Child & Women Helpline",
    description: "Missing persons, child tracing",
    number: "1094",
    scope: "All India",
    hours: "24×7",
    country: "India"
  },
  {
    category: "Cyber Crime",
    serviceName: "National Cyber Crime Helpline",
    description: "Online fraud, cyber harassment, bullying",
    number: "1930",
    scope: "All India",
    hours: "24×7",
    country: "India"
  },
  {
    category: "Health & Medical",
    serviceName: "AIDS Helpline",
    description: "HIV/AIDS information, testing, treatment",
    number: "1097",
    scope: "All India",
    hours: "24×7",
    country: "India"
  },
  {
    category: "Health & Medical",
    serviceName: "Blood Bank Helpline",
    description: "Blood donation, transfusion services",
    number: "104 or 1910",
    scope: "All India",
    hours: "24×7",
    country: "India"
  },
  {
    category: "Health & Medical",
    serviceName: "Mental Health Helpline (Tele MANAS)",
    description: "Mental health support, counseling",
    number: "14416",
    scope: "All India",
    hours: "24×7",
    country: "India"
  },
  {
    category: "Health & Medical",
    serviceName: "Drug De-addiction Helpline",
    description: "Substance abuse, addiction treatment",
    number: "1800110031",
    scope: "All India",
    hours: "24×7",
    country: "India"
  },
  {
    category: "Health & Medical",
    serviceName: "National Poison Information Centre",
    description: "Poisoning emergencies, antidote info",
    number: "1066 or 011-1066",
    scope: "All India",
    hours: "24×7",
    country: "India"
  },
  {
    category: "Highway & Transportation",
    serviceName: "National Highway Emergency Service",
    description: "Accidents, breakdowns, highway emergencies",
    number: "1033",
    scope: "National Highways",
    hours: "24×7",
    country: "India"
  },
  {
    category: "Highway & Transportation",
    serviceName: "Railway Passenger Security",
    description: "Train crime, harassment, accidents",
    number: "182",
    scope: "Indian Railways",
    hours: "24×7",
    country: "India"
  },
  {
    category: "Highway & Transportation",
    serviceName: "Railway Protection Force (RPF)",
    description: "General railway emergencies",
    number: "139",
    scope: "Indian Railways",
    hours: "24×7",
    country: "India"
  },
  {
    category: "Highway & Transportation",
    serviceName: "Government Railway Police",
    description: "Train accidents, specific incidents",
    number: "9833331111",
    scope: "Indian Railways",
    hours: "24×7",
    country: "India"
  },
  {
    category: "Disaster Management",
    serviceName: "Relief Commissioner",
    description: "Natural calamities relief",
    number: "1070",
    scope: "All India",
    hours: "24×7",
    country: "India"
  },
  {
    category: "Disaster Management",
    serviceName: "NDRF Headquarters",
    description: "Disaster response coordination",
    number: "011-24363260 or 9711077372",
    scope: "All India",
    hours: "24×7",
    country: "India"
  },
  {
    category: "Special Populations",
    serviceName: "Elder Line - Senior Citizens Helpline",
    description: "Senior citizen abuse, support",
    number: "011-20893999 or 011-20893995",
    scope: "All India",
    hours: "24×7",
    country: "India"
  },
  {
    category: "Special Populations",
    serviceName: "Kisan Call Centre",
    description: "Agricultural information, farming support",
    number: "1800-1801551",
    scope: "All India",
    hours: "Business Hours",
    country: "India"
  },
  {
    category: "Organ & Donation",
    serviceName: "National Organ Donation & Transplant",
    description: "Organ donation information, coordination",
    number: "1800-103-7100",
    scope: "All India",
    hours: "24×7",
    country: "India"
  },
  {
    category: "Organ & Donation",
    serviceName: "NOTTO Helpline",
    description: "Organ donation tele-counseling",
    number: "1800114770",
    scope: "All India",
    hours: "24×7",
    country: "India"
  },
  {
    category: "Other Services",
    serviceName: "Senior Citizen Helpline",
    description: "General senior citizen support",
    number: "14567",
    scope: "All India",
    hours: "24×7",
    country: "India"
  },
  {
    category: "Other Services",
    serviceName: "Air Ambulance Service",
    description: "Emergency air medical transport",
    number: "9540161344",
    scope: "Pan-India",
    hours: "24×7",
    country: "India"
  },
  {
    category: "Other Services",
    serviceName: "Anti-Corruption Helpline",
    description: "Corruption reporting",
    number: "1031",
    scope: "All India",
    hours: "24×7",
    country: "India"
  },
  {
    category: "Maharashtra - Mumbai",
    serviceName: "Police",
    description: "Crime reporting, emergency assistance",
    number: "100, 112, or 022-22621855",
    scope: "Mumbai",
    hours: "24×7",
    country: "India"
  },
  {
    category: "Maharashtra - Mumbai",
    serviceName: "Fire Brigade",
    description: "Fire emergencies, rescue",
    number: "101, 022-23085991/992, or 112",
    scope: "Mumbai",
    hours: "24×7",
    country: "India"
  },
  {
    category: "Maharashtra - Mumbai",
    serviceName: "Ambulance Services",
    description: "Medical emergency, patient transport",
    number: "102, 108, 1298, or 022-24308888",
    scope: "Mumbai",
    hours: "24×7",
    country: "India"
  },
  {
    category: "Maharashtra - Mumbai",
    serviceName: "Disaster Management Control",
    description: "MCGM disaster coordination",
    number: "022-22694725/27 or 108",
    scope: "Mumbai",
    hours: "24×7",
    country: "India"
  },
  {
    category: "Maharashtra - Mumbai",
    serviceName: "Women Helpline",
    description: "Women safety, domestic violence",
    number: "022-22633333 or 022-22620111",
    scope: "Mumbai",
    hours: "24×7",
    country: "India"
  },
  {
    category: "Maharashtra - Mumbai",
    serviceName: "Traffic Police Control",
    description: "Traffic violations, accidents",
    number: "022-24937755 or 022-24937746",
    scope: "Mumbai",
    hours: "24×7",
    country: "India"
  },
  {
    category: "Maharashtra - Mumbai",
    serviceName: "Highway Safety Patrol",
    description: "National highway emergencies",
    number: "022-22626655",
    scope: "Mumbai",
    hours: "24×7",
    country: "India"
  },
  {
    category: "Maharashtra - Mumbai",
    serviceName: "Police Infoline/Crime Stopper",
    description: "Anonymous crime reporting",
    number: "1090",
    scope: "Mumbai",
    hours: "24×7",
    country: "India"
  },
  {
    category: "Maharashtra - Mumbai",
    serviceName: "Tourist Police",
    description: "Tourist safety, assistance",
    number: "022-22621855",
    scope: "Mumbai",
    hours: "24×7",
    country: "India"
  },
  {
    category: "Maharashtra - Mumbai",
    serviceName: "Cyber Police Station",
    description: "Cyber crime reporting",
    number: "9820810007 or 022-26504008",
    scope: "Mumbai",
    hours: "24×7",
    country: "India"
  },
  {
    category: "Maharashtra - Mumbai",
    serviceName: "BMC Monsoon Disaster Helpline",
    description: "Monsoon/civic emergencies",
    number: "1916 or 1292",
    scope: "Mumbai",
    hours: "Monsoon Season",
    country: "India"
  },
  {
    category: "Maharashtra - Mumbai",
    serviceName: "BMC Pothole Complaint",
    description: "Infrastructure issues",
    number: "1916/1292 or 022-22691292/93",
    scope: "Mumbai",
    hours: "24×7",
    country: "India"
  },
  {
    category: "Maharashtra - Mumbai",
    serviceName: "Mumbai Airport",
    description: "Airport emergencies, services",
    number: "022-66851010",
    scope: "Mumbai",
    hours: "24×7",
    country: "India"
  },
  {
    category: "Maharashtra - Mumbai",
    serviceName: "Tourism Enquiry (MTDC)",
    description: "Tourist information",
    number: "022-22024482 or 022-22-24522",
    scope: "Mumbai",
    hours: "Business Hours",
    country: "India"
  },
  {
    category: "Maharashtra - Mumbai",
    serviceName: "Western Railways RPF",
    description: "Railway emergency (Western region)",
    number: "1311",
    scope: "Mumbai",
    hours: "24×7",
    country: "India"
  },
  {
    category: "Maharashtra - Mumbai",
    serviceName: "Central Railways RPF",
    description: "Railway emergency (Central region)",
    number: "1275",
    scope: "Mumbai",
    hours: "24×7",
    country: "India"
  },
  {
    category: "Maharashtra - Mumbai",
    serviceName: "All India Railway Security",
    description: "Rail passenger security",
    number: "182",
    scope: "Indian Railways",
    hours: "24×7",
    country: "India"
  },
  {
    category: "Maharashtra - Mumbai",
    serviceName: "Railway Customer Services",
    description: "Medical, food, coach issues",
    number: "138",
    scope: "Indian Railways",
    hours: "24×7",
    country: "India"
  },
  {
    category: "Maharashtra - Mumbai",
    serviceName: "Railway Enquiry",
    description: "General railway information",
    number: "139",
    scope: "Indian Railways",
    hours: "24×7",
    country: "India"
  },
  {
    category: "Maharashtra - Mumbai",
    serviceName: "Government Railway Police",
    description: "Rail accidents, incidents",
    number: "9833331111",
    scope: "Mumbai",
    hours: "24×7",
    country: "India"
  },
  {
    category: "Maharashtra - Mumbai",
    serviceName: "Blood Bank Helpline",
    description: "Blood donation, transfusion",
    number: "104 or 1910",
    scope: "All Maharashtra",
    hours: "24×7",
    country: "India"
  },
  {
    category: "Maharashtra - Mumbai",
    serviceName: "St. George Blood Bank",
    description: "Blood supply, donation",
    number: "022-22620344, 22621420, 22620242",
    scope: "Mumbai",
    hours: "24×7",
    country: "India"
  },
  {
    category: "Maharashtra - Mumbai",
    serviceName: "Indian Red Cross Society",
    description: "Blood donation services",
    number: "022-22663195, 22663560, 40500400",
    scope: "Mumbai",
    hours: "24×7",
    country: "India"
  },
  {
    category: "Maharashtra - Mumbai",
    serviceName: "Lilavati Hospital Blood Bank",
    description: "Blood services",
    number: "022-26568214, 26568215, 26568000 Ext 8215",
    scope: "Mumbai",
    hours: "24×7",
    country: "India"
  },
  {
    category: "Maharashtra - Mumbai",
    serviceName: "Tata Memorial Hospital Blood Bank",
    description: "Cancer hospital blood services",
    number: "24170000 or 24127096",
    scope: "Mumbai",
    hours: "24×7",
    country: "India"
  },
  {
    category: "Maharashtra - Mumbai",
    serviceName: "Kama Hospital Blood Bank",
    description: "Blood donation, transfusion",
    number: "022-22611654 or 22611871 Ext 319",
    scope: "Mumbai",
    hours: "24×7",
    country: "India"
  },
  {
    category: "Maharashtra - Mumbai",
    serviceName: "J.J. Hospital Emergency",
    description: "Government medical facility",
    number: "022-2373-5555",
    scope: "Mumbai",
    hours: "24×7",
    country: "India"
  },
  {
    category: "Maharashtra - Mumbai",
    serviceName: "G.T. Hospital Emergency",
    description: "Government medical facility",
    number: "022-22031111 or 022-22621468",
    scope: "Mumbai",
    hours: "24×7",
    country: "India"
  },
  {
    category: "Maharashtra - Mumbai",
    serviceName: "Lokmanya Tilak Hospital (Sion)",
    description: "Government medical facility",
    number: "022-24063000, 24076381, 24092020, 24082504",
    scope: "Mumbai",
    hours: "24×7",
    country: "India"
  },
  {
    category: "Maharashtra - Mumbai",
    serviceName: "Nair Hospital Emergency",
    description: "Government medical facility",
    number: "022-23027000",
    scope: "Mumbai",
    hours: "24×7",
    country: "India"
  },
  {
    category: "Maharashtra - Mumbai",
    serviceName: "KEM Hospital (Parel) Emergency",
    description: "Government medical facility",
    number: "022-24107000, 24137517, 24131763",
    scope: "Mumbai",
    hours: "24×7",
    country: "India"
  },
  {
    category: "Maharashtra - Mumbai",
    serviceName: "Breach Candy Hospital",
    description: "Government medical facility",
    number: "022-62597809 or 62597788",
    scope: "Mumbai",
    hours: "24×7",
    country: "India"
  },
  {
    category: "Maharashtra - Mumbai",
    serviceName: "Bombay Hospital Emergency",
    description: "Private medical facility",
    number: "022-22067676 or 40511111",
    scope: "Mumbai",
    hours: "24×7",
    country: "India"
  },
  {
    category: "Maharashtra - Mumbai",
    serviceName: "Jaslok Hospital Emergency",
    description: "Private medical facility",
    number: "022-66573333 or 022-40173333",
    scope: "Mumbai",
    hours: "24×7",
    country: "India"
  },
  {
    category: "Maharashtra - Mumbai",
    serviceName: "Hinduja National Hospital",
    description: "Private medical facility",
    number: "022-24451515 Ext 8308 or 022-24447308",
    scope: "Mumbai",
    hours: "24×7",
    country: "India"
  },
  {
    category: "Maharashtra - Mumbai",
    serviceName: "Reliance Harkisandas Hospital",
    description: "Private medical facility",
    number: "022-3547-5005 or 1-800-221-166, 1-800-890-1111",
    scope: "Mumbai",
    hours: "24×7",
    country: "India"
  },
  {
    category: "Maharashtra - Mumbai",
    serviceName: "Cooper Hospital Emergency",
    description: "Private medical facility",
    number: "022-26207254",
    scope: "Mumbai",
    hours: "24×7",
    country: "India"
  },
  {
    category: "Maharashtra - Pune",
    serviceName: "Police Emergency",
    description: "Crime reporting, emergencies",
    number: "100 or 112",
    scope: "Pune",
    hours: "24×7",
    country: "India"
  },
  {
    category: "Maharashtra - Pune",
    serviceName: "Ambulance Services",
    description: "Medical emergency",
    number: "108",
    scope: "Pune",
    hours: "24×7",
    country: "India"
  },
  {
    category: "Maharashtra - Pune",
    serviceName: "Fire Brigade",
    description: "Fire emergencies",
    number: "104",
    scope: "Pune",
    hours: "24×7",
    country: "India"
  },
  {
    category: "Maharashtra - Pune",
    serviceName: "Disaster Management Control",
    description: "Disaster coordination",
    number: "1077",
    scope: "Pune",
    hours: "24×7",
    country: "India"
  },
  {
    category: "Maharashtra - Pune",
    serviceName: "District Collector/Magistrate",
    description: "Administrative emergency",
    number: "020-26114949",
    scope: "Pune",
    hours: "Business Hours",
    country: "India"
  },
  {
    category: "Maharashtra - Pune",
    serviceName: "District Emergency Operation Centre",
    description: "DEOC coordination",
    number: "020-26123371 or 9370960061",
    scope: "Pune",
    hours: "24×7",
    country: "India"
  },
  {
    category: "Maharashtra - Pune",
    serviceName: "Cyber Crime Services",
    description: "Cyber crime reporting",
    number: "7058719375, 7058719371, or 020-29710097",
    scope: "Pune",
    hours: "24×7",
    country: "India"
  },
  {
    category: "Maharashtra - Pune",
    serviceName: "Pimpri-Chinchwad Cyber Cell",
    description: "PCMC cyber crime",
    number: "020-27350939",
    scope: "Pune",
    hours: "24×7",
    country: "India"
  },
  {
    category: "Maharashtra - Pune",
    serviceName: "Pune Rural (Gramin) Cyber Cell",
    description: "Rural cyber crime",
    number: "020-25654616",
    scope: "Pune",
    hours: "24×7",
    country: "India"
  },
  {
    category: "Maharashtra - Nagpur",
    serviceName: "District Collector/Magistrate",
    description: "Administrative emergency",
    number: "0712-2564973",
    scope: "Nagpur",
    hours: "Business Hours",
    country: "India"
  },
  {
    category: "Maharashtra - Nagpur",
    serviceName: "District Emergency Operation Centre",
    description: "DEOC coordination",
    number: "0712-2562668",
    scope: "Nagpur",
    hours: "24×7",
    country: "India"
  },
  {
    category: "Maharashtra - Thane",
    serviceName: "District Collector/Magistrate",
    description: "Administrative emergency",
    number: "022-25344041",
    scope: "Thane",
    hours: "Business Hours",
    country: "India"
  },
  {
    category: "Maharashtra - Thane",
    serviceName: "District Emergency Operation Centre",
    description: "DEOC coordination",
    number: "022-25301740 or 9372338827",
    scope: "Thane",
    hours: "24×7",
    country: "India"
  },
  {
    category: "Maharashtra - Raigad",
    serviceName: "Police Emergency",
    description: "Crime reporting, emergencies",
    number: "100 or 112",
    scope: "Raigad",
    hours: "24×7",
    country: "India"
  },
  {
    category: "Maharashtra - Raigad",
    serviceName: "Fire Service",
    description: "Fire emergencies",
    number: "101",
    scope: "Raigad",
    hours: "24×7",
    country: "India"
  },
  {
    category: "Maharashtra - Raigad",
    serviceName: "Ambulance Services",
    description: "Medical emergency",
    number: "108",
    scope: "Raigad",
    hours: "24×7",
    country: "India"
  },
  {
    category: "Maharashtra - Raigad",
    serviceName: "Railway Accident",
    description: "Railway emergencies",
    number: "1072",
    scope: "Raigad",
    hours: "24×7",
    country: "India"
  },
  {
    category: "Maharashtra - Raigad",
    serviceName: "Medical Advice Service",
    description: "Health information",
    number: "104",
    scope: "Raigad",
    hours: "24×7",
    country: "India"
  },
  {
    category: "Maharashtra - Raigad",
    serviceName: "Emergency & Disaster Management",
    description: "Disaster coordination",
    number: "108 or 1077",
    scope: "Raigad",
    hours: "24×7",
    country: "India"
  },
  {
    category: "Maharashtra - Mumbai Suburban",
    serviceName: "Citizens Call Centre",
    description: "General citizen services",
    number: "155300",
    scope: "Mumbai Suburban",
    hours: "24×7",
    country: "India"
  },
  {
    category: "Maharashtra - Mumbai Suburban",
    serviceName: "Police Helpline",
    description: "Crime reporting, emergencies",
    number: "100",
    scope: "Mumbai Suburban",
    hours: "24×7",
    country: "India"
  },
  {
    category: "Maharashtra - Mumbai Suburban",
    serviceName: "Crime Stopper",
    description: "Anonymous crime reporting",
    number: "1090",
    scope: "Mumbai Suburban",
    hours: "24×7",
    country: "India"
  },
  {
    category: "Maharashtra - Mumbai Suburban",
    serviceName: "Rescue and Relief",
    description: "Disaster response",
    number: "1070",
    scope: "Mumbai Suburban",
    hours: "24×7",
    country: "India"
  },
  {
    category: "Maharashtra - Mumbai Suburban",
    serviceName: "Ambulance Services",
    description: "Medical emergency",
    number: "102 or 108",
    scope: "Mumbai Suburban",
    hours: "24×7",
    country: "India"
  },
  {
    category: "Maharashtra - Chhatrapati Sambhajinagar",
    serviceName: "District Services",
    description: "District administration",
    number: "Various",
    scope: "Chhatrapati Sambhajinagar",
    hours: "Business Hours",
    country: "India"
  },
  {
    category: "Maharashtra - State",
    serviceName: "Maharashtra Police Website",
    description: "Police information, complaints",
    number: "http://www.mahapolice.gov.in/",
    scope: "All Maharashtra",
    hours: "24×7",
    country: "India"
  },
  {
    category: "Maharashtra - State",
    serviceName: "Aapale Sarkar",
    description: "Citizen services, applications",
    number: "https://aaplesarkar.mahaonline.gov.in/",
    scope: "All Maharashtra",
    hours: "24×7",
    country: "India"
  }
];
