/** The 163 Phase 3 call type ids by family (design §4.3). */
export const EXPECTED_TYPES: Readonly<Record<string, readonly string[]>> = {
  contact: ['pedestrianStop', 'fieldInterview'],
  dui: ['impairedDriver', 'wrongWayDriver', 'recklessDriver', 'driverAsleepAtWheel', 'erraticDriverHighway', 'intoxicatedDriverParkingLot'],
  collision: ['injuryCollision', 'hitAndRunCollision', 'pedestrianStruck', 'singleVehicleCrash', 'motorcycleCrash', 'parkingLotCollision', 'collisionBlockingLanes', 'rolloverCrash'],
  disturbance: ['loudParty', 'neighborDispute', 'intoxicatedPerson', 'disorderlyPerson', 'panhandling', 'verbalDispute', 'landlordTenantDispute', 'customerDispute', 'roadRageReport', 'fireworksComplaint', 'loudMusicVehicle'],
  domestic: ['domesticDisturbance', 'domesticViolenceInjury', 'protectiveOrderViolation', 'familyDispute', 'childCustodyDispute', 'elderAbuseReport', 'domesticWithWeapon'],
  welfare: ['welfareCheckElderly', 'slumpedInVehicle', 'foundPersonConfused', 'citizenAssist', 'welfareCheckNoAnswer', 'strandedMotorist'],
  crisis: ['suicidalSubject', 'mentalHealthCrisis', 'suicidalSubjectArmed', 'personOnLedge', 'erraticBehavior', 'crisisThirdParty', 'threatsOfSelfHarm'],
  medical: ['overdose', 'personDown', 'unconsciousPerson', 'injuredPerson', 'medicalAssist', 'seizureInPublic', 'intoxicatedUnconscious'],
  property: ['burglaryCold', 'vehicleBurglaryCold', 'theftReport', 'vandalismReport', 'fraudReport', 'identityTheftReport', 'counterfeitCurrency', 'foundProperty', 'lostProperty', 'packageTheft'],
  retail: ['shopliftingDetained', 'shopliftingFled', 'shopliftingInProgress', 'dineAndDash', 'gasDriveOff'],
  trespass: ['trespass', 'trespassVacantBuilding', 'unwantedGuest', 'loiteringBusiness', 'squatters', 'trespassSchoolGrounds'],
  inProgress: ['burglaryInProgress', 'prowler', 'vehicleBreakInProgress', 'theftInProgress', 'commercialBurglaryInProgress', 'peepingPerson'],
  violent: ['robbery', 'armedRobbery', 'strongArmRobbery', 'assaultInProgress', 'fightInProgress', 'stabbingReported', 'assaultCold', 'carjacking'],
  weapons: ['shotsFired', 'armedPerson', 'personWithKnife', 'brandishing', 'personWithGun', 'driveByShooting', 'firearmDischargeRural'],
  activeAssailant: ['activeAssailant', 'activeAssailantBusiness', 'massCasualtyReport'],
  barricade: ['hostageSituation', 'barricadedSubject', 'barricadedArmed'],
  wanted: ['wantedSubject', 'warrantService', 'probationViolatorSighted', 'paroleeAbsconder', 'boloPersonSighted'],
  vehicleWanted: ['stolenVehicleSighted', 'felonyStopVehicle', 'boloVehicleSighted', 'carjackedVehicleSighted', 'stolenVehicleRecovered'],
  pursuit: ['vehiclePursuit', 'footPursuit'],
  missing: ['missingPerson', 'missingElderly', 'juvenileRunaway', 'missingAtRisk', 'foundJuvenile'],
  crowd: ['protest', 'crowdManagement', 'specialEventTraffic', 'largeFight', 'unrulyCrowd', 'streetRacingGathering', 'paradeTrafficControl'],
  hazard: ['hazmatSpill', 'gasLeak', 'bombThreat', 'suspiciousPackage', 'downedPowerLines', 'roadwayFlooding', 'treeDownBlockingRoad', 'fireReportAssist'],
  animal: ['strayDog', 'aggressiveDog', 'animalBite', 'injuredAnimal', 'animalInHotVehicle', 'livestockOnRoadway', 'animalNoiseComplaint'],
  parking: ['blockedDriveway', 'abandonedVehicle', 'fireLaneViolation', 'disabledParkingViolation', 'doubleParked', 'vehicleBlockingTraffic'],
  investigation: ['deathInvestigation', 'unattendedDeath', 'sexualAssaultScene', 'sexualAssaultReport', 'stalkingReport', 'harassmentReport', 'criminalThreats', 'schoolThreat', 'extortionReport'],
  service: ['civilStandby', 'propertyRetrieval', 'vehicleLockout', 'k9TrackRequest', 'motoristAssist', 'funeralEscort', 'bankEscort'],
};

/** Families of the design (§4.3), in order. */
export const EXPECTED_FAMILIES: readonly string[] = ['trafficStop', ...Object.keys(EXPECTED_TYPES)];

/** Required call types of the requirement map (design §18). */
export const REQUIRED_TYPES: readonly string[] = [
  'trafficStop', 'impairedDriver', 'minorCollision', 'injuryCollision', 'domesticDisturbance', 'welfareCheck', 'noiseComplaint',
  'loudParty', 'trespass', 'shopliftingDetained', 'burglaryInProgress', 'burglaryCold', 'robbery', 'shotsFired', 'activeAssailant',
  'armedPerson', 'suicidalSubject', 'overdose', 'missingPerson', 'foundPersonConfused', 'juvenileRunaway', 'wantedSubject',
  'felonyStopVehicle', 'vehiclePursuit', 'footPursuit', 'hostageSituation', 'barricadedSubject', 'k9TrackRequest', 'warrantService',
  'protest', 'crowdManagement', 'specialEventTraffic', 'blockedDriveway', 'parkingComplaint', 'strayDog', 'hazmatSpill', 'bombThreat',
  'stolenVehicleSighted', 'fraudReport', 'stalkingReport', 'sexualAssaultScene', 'deathInvestigation', 'schoolThreat',
];
