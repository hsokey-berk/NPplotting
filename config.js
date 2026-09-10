// ---- Configuration ----
// Name of the CSV file in this same repository/folder.
// If you rename the file (e.g. a new month's export), just update this
// one line — nothing else in the site needs to change.

const CSV_FILENAME = "August2026v2.csv";

// Which Site to select by default when the page loads. If this value
// isn't found in the data, the site falls back to the first one
// alphabetically — same as before.

const DEFAULT_SITE = "Rivendell";

// Conversion from raw Neutron Count (MD) to Theta (volumetric water
// content), applied as: Theta = THETA_SLOPE * neutronCount + THETA_INTERCEPT
//
// Update these two numbers if the probe is recalibrated — nothing else
// in the site needs to change.

const THETA_SLOPE = 0.00005442;
const THETA_INTERCEPT = -0.1602;

