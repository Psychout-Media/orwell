/**
 * ORW-508 Layer 1: the place table the hometown deal draws from, at real-world frequency.
 *
 * Shape and source. Each row is `City, ST|population in thousands`. This file is an AUTHORED SAMPLE
 * (about 510 places, populations rounded from public census figures, spread over all fifty states and
 * from big cities to towns under 10,000). It has the exact shape of the table that replaces it: the
 * Census Bureau Gazetteer places file (public domain) reduced to name, state and population for places
 * with 1,000 or more residents, about 10,000 rows. Only this file changes when the full extract lands;
 * the sampler, the caps and the tests do not.
 *
 * Region comes from the state (Census regions). Size class comes from the population.
 */
import type { Hometown } from "./hometowns";

export type SizeClass = "big-city" | "city" | "small-city" | "town";

export interface WorldPlace {
  /** "City, ST" (the string the card and the narrator use). */
  readonly city: string;
  readonly state: string;
  readonly region: Hometown["region"];
  /** Residents in thousands (the draw weight before flattening). */
  readonly popK: number;
  readonly size: SizeClass;
}

const REGION_OF_STATE: Readonly<Record<string, Hometown["region"]>> = {
  CT: "Northeast", ME: "Northeast", MA: "Northeast", NH: "Northeast", RI: "Northeast", VT: "Northeast", NJ: "Northeast", NY: "Northeast", PA: "Northeast",
  IL: "Midwest", IN: "Midwest", MI: "Midwest", OH: "Midwest", WI: "Midwest", IA: "Midwest", KS: "Midwest", MN: "Midwest", MO: "Midwest", NE: "Midwest", ND: "Midwest", SD: "Midwest",
  DE: "South", FL: "South", GA: "South", MD: "South", NC: "South", SC: "South", VA: "South", DC: "South", WV: "South", AL: "South", KY: "South", MS: "South", TN: "South", AR: "South", LA: "South", OK: "South", TX: "South",
  AZ: "West", CO: "West", ID: "West", MT: "West", NV: "West", NM: "West", UT: "West", WY: "West", AK: "West", CA: "West", HI: "West", OR: "West", WA: "West",
};

export function sizeClassOf(popK: number): SizeClass {
  return popK >= 500 ? "big-city" : popK >= 100 ? "city" : popK >= 25 ? "small-city" : "town";
}

const RAW = `
New York, NY|8800
Los Angeles, CA|3900
Chicago, IL|2700
Houston, TX|2300
Phoenix, AZ|1600
Philadelphia, PA|1600
San Antonio, TX|1500
San Diego, CA|1400
Dallas, TX|1300
San Jose, CA|1000
Fort Worth, TX|960
Austin, TX|960
Jacksonville, FL|950
Columbus, OH|910
Charlotte, NC|880
Indianapolis, IN|880
San Francisco, CA|810
Seattle, WA|740
Denver, CO|715
Oklahoma City, OK|690
Nashville, TN|690
El Paso, TX|680
Boston, MA|675
Portland, OR|650
Las Vegas, NV|640
Detroit, MI|640
Memphis, TN|630
Louisville, KY|630
Baltimore, MD|585
Milwaukee, WI|575
Albuquerque, NM|560
Tucson, AZ|545
Fresno, CA|540
Sacramento, CA|525
Mesa, AZ|505
Atlanta, GA|500
Kansas City, MO|510
Colorado Springs, CO|480
Omaha, NE|485
Raleigh, NC|470
Miami, FL|440
Virginia Beach, VA|450
Oakland, CA|440
Minneapolis, MN|430
Tulsa, OK|410
Bakersfield, CA|405
Wichita, KS|395
Arlington, TX|395
Aurora, CO|390
Tampa, FL|385
New Orleans, LA|385
Cleveland, OH|370
Honolulu, HI|350
Anaheim, CA|345
Lexington, KY|320
Stockton, CA|320
Henderson, NV|320
Corpus Christi, TX|317
Riverside, CA|315
Newark, NJ|305
Saint Paul, MN|310
Santa Ana, CA|310
Cincinnati, OH|310
Irvine, CA|310
Orlando, FL|310
Pittsburgh, PA|300
St. Louis, MO|300
Greensboro, NC|300
Jersey City, NJ|290
Anchorage, AK|290
Lincoln, NE|290
Plano, TX|285
Durham, NC|285
Buffalo, NY|278
Chandler, AZ|275
Chula Vista, CA|275
Toledo, OH|270
Madison, WI|270
Gilbert, AZ|270
Reno, NV|265
Fort Wayne, IN|265
St. Petersburg, FL|260
Lubbock, TX|260
Irving, TX|255
Laredo, TX|255
Winston-Salem, NC|250
Chesapeake, VA|250
Glendale, AZ|250
Garland, TX|245
Scottsdale, AZ|240
Norfolk, VA|235
Boise, ID|235
Fremont, CA|230
Spokane, WA|230
Richmond, VA|230
Baton Rouge, LA|220
Tacoma, WA|220
San Bernardino, CA|220
Modesto, CA|218
Huntsville, AL|215
Des Moines, IA|215
Yonkers, NY|211
Rochester, NY|211
Moreno Valley, CA|210
Fayetteville, NC|208
Columbus, GA|206
Worcester, MA|206
Port St. Lucie, FL|204
Little Rock, AR|202
Augusta, GA|202
Oxnard, CA|202
Birmingham, AL|200
Montgomery, AL|200
Amarillo, TX|200
Salt Lake City, UT|200
Grand Rapids, MI|198
Huntington Beach, CA|198
Overland Park, KS|197
Tallahassee, FL|196
Grand Prairie, TX|196
McKinney, TX|195
Cape Coral, FL|195
Sioux Falls, SD|192
Providence, RI|190
Vancouver, WA|190
Knoxville, TN|190
Akron, OH|190
Shreveport, LA|187
Mobile, AL|187
Brownsville, TX|186
Newport News, VA|185
Fort Lauderdale, FL|182
Chattanooga, TN|181
Tempe, AZ|181
Santa Rosa, CA|178
Eugene, OR|176
Salem, OR|175
Cary, NC|175
Springfield, MO|169
Fort Collins, CO|170
Clarksville, TN|166
Salinas, CA|163
Hayward, CA|162
Springfield, MA|155
Lakewood, CO|155
Alexandria, VA|155
Macon, GA|157
Corona, CA|157
Pasadena, TX|151
Killeen, TX|153
Hollywood, FL|153
Joliet, IL|150
Naperville, IL|150
Bellevue, WA|150
Jackson, MS|150
Escondido, CA|151
Rockford, IL|148
Syracuse, NY|148
Savannah, GA|147
Torrance, CA|147
Bridgeport, CT|148
Roseville, CA|147
Visalia, CA|141
Gainesville, FL|141
Olathe, KS|141
Thornton, CO|141
Warren, MI|139
Denton, TX|139
Waco, TX|139
Dayton, OH|137
Cedar Rapids, IA|137
Elizabeth, NJ|137
Columbia, SC|136
Stamford, CT|135
Midland, TX|132
McAllen, TX|142
Charleston, SC|150
Long Beach, CA|460
Columbia, MO|126
Topeka, KS|126
Fargo, ND|125
Allentown, PA|125
Ann Arbor, MI|123
Independence, MO|123
Hartford, CT|121
Lafayette, LA|121
Rochester, MN|121
Evansville, IN|117
Billings, MT|117
Cambridge, MA|118
Wilmington, NC|115
Provo, UT|115
Lowell, MA|115
Manchester, NH|115
Springfield, IL|114
Lansing, MI|112
Pueblo, CO|112
Lakeland, FL|112
Norman, OK|128
Abilene, TX|125
Tyler, TX|107
Green Bay, WI|107
South Bend, IN|103
Chico, CA|102
Davenport, IA|101
Roanoke, VA|100
Tuscaloosa, AL|100
Albany, NY|100
Bend, OR|100
San Angelo, TX|100
Kenosha, WI|99
Reading, PA|95
Erie, PA|95
Redding, CA|93
Fayetteville, AR|93
Asheville, NC|94
Santa Barbara, CA|88
Santa Fe, NM|88
Boulder, CO|105
Peoria, IL|113
Duluth, MN|86
Champaign, IL|88
Sioux City, IA|85
Medford, OR|85
Lake Charles, LA|84
Longview, TX|82
Flint, MI|81
Auburn, AL|77
Bloomington, IN|79
Lynchburg, VA|79
Frederick, MD|78
Missoula, MT|75
Iowa City, IA|75
Bethlehem, PA|75
Scranton, PA|76
Rapid City, SD|77
Flagstaff, AZ|77
Bismarck, ND|74
Kalamazoo, MI|73
Bowling Green, KY|72
Daytona Beach, FL|72
Harlingen, TX|72
Johnson City, TN|71
Dothan, AL|71
Canton, OH|71
Greenville, SC|70
Portland, ME|68
Jackson, TN|68
Cheyenne, WY|65
Idaho Falls, ID|65
Muskogee, OK|37
Ames, IA|66
Bellingham, WA|92
Yakima, WA|96
Everett, WA|110
Ogden, UT|87
St. George, UT|95
Logan, UT|52
Las Cruces, NM|111
Yuma, AZ|95
Grand Junction, CO|66
Casper, WY|59
Great Falls, MT|60
Bozeman, MT|54
Coeur d'Alene, ID|55
Pocatello, ID|56
Twin Falls, ID|52
Olympia, WA|55
Walla Walla, WA|34
Wenatchee, WA|35
Corvallis, OR|59
Carson City, NV|58
Sparks, NV|108
Lawton, OK|90
Stillwater, OK|49
Enid, OK|51
Fort Smith, AR|89
Jonesboro, AR|78
Hot Springs, AR|38
Monroe, LA|47
Alexandria, LA|45
Houma, LA|33
Hattiesburg, MS|48
Gulfport, MS|72
Tupelo, MS|38
Biloxi, MS|49
Oxford, MS|25
Pensacola, FL|54
Sarasota, FL|55
Panama City, FL|36
Key West, FL|25
Valdosta, GA|56
Albany, GA|69
Rome, GA|37
Athens, GA|127
Gainesville, GA|43
Marietta, GA|61
Sandy Springs, GA|108
Myrtle Beach, SC|35
Charlottesville, VA|46
Blacksburg, VA|45
Annapolis, MD|40
Hagerstown, MD|43
Silver Spring, MD|81
Wilmington, DE|70
Dover, DE|39
Charleston, WV|48
Huntington, WV|46
Morgantown, WV|31
Paducah, KY|26
Owensboro, KY|60
Cookeville, TN|35
Murfreesboro, TN|152
Terre Haute, IN|58
Muncie, IN|65
Lafayette, IN|70
Kokomo, IN|59
Youngstown, OH|60
Mansfield, OH|47
Athens, OH|24
Saginaw, MI|44
Traverse City, MI|16
Marquette, MI|21
Dearborn, MI|110
Royal Oak, MI|58
St. Cloud, MN|69
Mankato, MN|44
Bloomington, MN|89
Eau Claire, WI|69
La Crosse, WI|52
Oshkosh, WI|66
Wausau, WI|39
Decatur, IL|70
Bloomington, IL|78
Carbondale, IL|22
Evanston, IL|75
Cicero, IL|85
Skokie, IL|67
Dubuque, IA|59
Council Bluffs, IA|62
Joplin, MO|52
St. Joseph, MO|72
Jefferson City, MO|43
Rolla, MO|20
Lee's Summit, MO|100
Grand Island, NE|53
Kearney, NE|34
Manhattan, KS|55
Salina, KS|46
Dodge City, KS|28
Grand Forks, ND|59
Minot, ND|48
Aberdeen, SD|28
Helena, MT|34
Laramie, WY|31
Jackson, WY|11
Durango, CO|20
Farmington, NM|46
Prescott, AZ|46
Elko, NV|20
Astoria, OR|10
Gresham, OR|114
Beaverton, OR|97
Federal Way, WA|101
Kent, WA|135
Fairbanks, AK|32
Juneau, AK|32
Ketchikan, AK|8
Hilo, HI|45
Lihue, HI|7
Eureka, CA|27
San Luis Obispo, CA|47
Santa Cruz, CA|62
Monterey, CA|30
Palm Springs, CA|45
Barstow, CA|25
Pasadena, CA|138
Santa Monica, CA|93
Berkeley, CA|125
Daly City, CA|104
Carlsbad, CA|115
Temecula, CA|110
Vacaville, CA|100
Galveston, TX|53
Rockport, TX|10
Victoria, TX|65
Texarkana, TX|37
Del Rio, TX|35
Kerrville, TX|25
Weatherford, TX|33
Marfa, TX|2
Odessa, TX|114
Beaumont, TX|115
Concord, NH|44
Burlington, VT|45
Lewiston, ME|37
Bangor, ME|32
Harrisburg, PA|50
Lancaster, PA|58
State College, PA|40
Levittown, PA|52
Trenton, NJ|90
Hoboken, NJ|60
Paterson, NJ|159
Plainfield, NJ|55
Mount Vernon, NY|73
Quincy, MA|101
Newton, MA|88
Brookline, MA|63
Kissimmee, FL|79
Plantation, FL|91
Brandon, FL|115
Decatur, GA|25
Smyrna, GA|56
Lehi, UT|75
Sandy, UT|96
West Valley City, UT|140
Naples, FL|20
Bishop, CA|4
Bisbee, AZ|5
Sedona, AZ|10
Page, AZ|7
Eureka Springs, AR|2
Mountain Home, AR|13
Truckee, CA|17
Mammoth Lakes, CA|8
Ojai, CA|8
Crescent City, CA|6
Susanville, CA|15
Telluride, CO|3
Salida, CO|6
Craig, CO|9
Steamboat Springs, CO|13
Mystic, CT|4
Litchfield, CT|8
Lewes, DE|3
Cedar Key, FL|1
Apalachicola, FL|2
Marathon, FL|9
Live Oak, FL|7
Blue Ridge, GA|1
Dahlonega, GA|7
Thomasville, GA|19
Kapaa, HI|11
Hana, HI|1
Sandpoint, ID|9
Salmon, ID|3
Galena, IL|3
Effingham, IL|13
Ottawa, IL|18
Nashville, IN|1
Madison, IN|12
Decorah, IA|8
Pella, IA|10
Spearville, KS|1
Lindsborg, KS|3
Berea, KY|15
Harlan, KY|1
Natchitoches, LA|18
Breaux Bridge, LA|8
Bar Harbor, ME|5
Camden, ME|5
Chestertown, MD|5
Cumberland, MD|19
Provincetown, MA|3
Pittsfield, MA|43
Petoskey, MI|6
Houghton, MI|8
Ely, MN|3
Grand Marais, MN|1
Bemidji, MN|15
Natchez, MS|14
Cleveland, MS|11
Hannibal, MO|17
Branson, MO|12
Whitefish, MT|8
Livingston, MT|8
Chadron, NE|5
North Platte, NE|23
Ely, NV|4
Tonopah, NV|2
Littleton, NH|6
Keene, NH|23
Cape May, NJ|3
Ocean City, NJ|11
Taos, NM|6
Silver City, NM|9
Cooperstown, NY|2
Saranac Lake, NY|5
Ithaca, NY|32
Boone, NC|19
Beaufort, NC|4
Valley City, ND|6
Medora, ND|1
Put-in-Bay, OH|1
Marietta, OH|13
Guymon, OK|12
Woodward, OK|12
Hood River, OR|8
Pendleton, OR|17
Gettysburg, PA|8
Wellsboro, PA|3
Newport, RI|25
Block Island, RI|1
Beaufort, SC|14
Georgetown, SC|8
Deadwood, SD|1
Mitchell, SD|15
Gatlinburg, TN|4
Dyersburg, TN|16
Fredericksburg, TX|11
Alpine, TX|6
Port Aransas, TX|3
Moab, UT|5
Park City, UT|8
Woodstock, VT|3
Brattleboro, VT|12
Staunton, VA|25
Chincoteague, VA|3
Port Angeles, WA|20
Forks, WA|3
Lewisburg, WV|4
Elkins, WV|7
Baraboo, WI|12
Sheridan, WY|18
Cody, WY|10
`;

export const WORLD_PLACES: readonly WorldPlace[] = (() => {
  const seen = new Set<string>();
  const out: WorldPlace[] = [];
  for (const line of RAW.split("\n")) {
    const row = line.trim();
    if (!row) continue;
    const [city, pop] = row.split("|") as [string, string];
    const state = city.slice(city.lastIndexOf(",") + 2);
    const region = REGION_OF_STATE[state];
    if (!region || seen.has(city)) continue; // a duplicate or unknown state is dropped, never thrown
    seen.add(city);
    const popK = Number(pop);
    out.push({ city, state, region, popK, size: sizeClassOf(popK) });
  }
  return out;
})();
