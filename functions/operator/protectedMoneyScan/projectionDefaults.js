import { DEFAULT_ADD_MONEY_CATEGORIES } from '../../../src/phase2b/transactionCategoryDisplay.js'
import { freeze } from './common.js'

// Exact client default settings, pinned by the operator integration contract.
const defaultSettings = {
      rentAmount: 0,
      studentRequestsEnabled: true,
      studentAddRequestsEnabled: true,
      studentSubtractRequestsEnabled: true,
      purchaseRequestsEnabled: true,
      requireTeacherApproval: true,
      reasons: [
        "Weekly payday",
        "Class job",
        "Showing work",
        "Desk rent",
        "Bathroom break",
        "Bonus",
        "Other"
      ],
      purchaseCategories: [
        "School Store",
        "Road Runner Tickets",
        "Other"
      ],
      addMoneyCategories: [...DEFAULT_ADD_MONEY_CATEGORIES],
      subtractMoneyCategories: [
        "Rent",
        "Restroom",
        "Class Store Purchase",
        "Roadrunner Ticket Purchase",
        "Negative Consequence",
        "Bad Language (Swearing, Racial Slurs, Etc...)",
        "Teacher's Choice"
      ]
    };
export const PROJECTION_DEFAULTS = freeze(defaultSettings)
