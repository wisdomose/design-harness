//! Art directions: the designer's vocabulary of distinct looks, kept in
//! `directions.json`. Every request carries the whole library, so the
//! designer can take a layout from one direction and type from another; the
//! server shuffles it and names a few starting points at random, because left
//! to choose freely a model goes back to its favourites every time.

use std::sync::LazyLock;

use rand::seq::SliceRandom;
use serde::Deserialize;

/// How many directions are named as starting points for a design.
const STARTING_POINTS: usize = 3;

#[derive(Deserialize)]
pub struct Direction {
    pub id: String,
    pub name: String,
    idea: String,
    composition: String,
    #[serde(rename = "type")]
    typography: String,
    colour: String,
    imagery: String,
    details: String,
}

pub static LIBRARY: LazyLock<Vec<Direction>> = LazyLock::new(|| {
    serde_json::from_str(include_str!("directions.json")).expect("directions.json is valid")
});

pub struct Pick {
    /// The library as text, in a fresh random order.
    pub library: String,
    /// The directions to build from, as (id, name).
    pub starting_points: Vec<(String, String)>,
}

/// Shuffles the library and picks starting points, avoiding the directions in
/// `recent` (ones the person has seen lately) while enough others remain.
pub fn pick(recent: &[String]) -> Pick {
    let mut rng = rand::rng();
    let mut order: Vec<&Direction> = LIBRARY.iter().collect();
    order.shuffle(&mut rng);

    let mut starting_points: Vec<&Direction> = order
        .iter()
        .copied()
        .filter(|d| !recent.contains(&d.id))
        .take(STARTING_POINTS)
        .collect();
    if starting_points.len() < STARTING_POINTS {
        starting_points = order.iter().copied().take(STARTING_POINTS).collect();
    }

    let library = order
        .iter()
        .map(|d| {
            format!(
                "## {} (id: {})\n{}\n- Composition: {}\n- Type: {}\n- Colour: {}\n- Imagery: {}\n- Details: {}",
                d.name, d.id, d.idea, d.composition, d.typography, d.colour, d.imagery, d.details
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n");

    Pick {
        library,
        starting_points: starting_points
            .iter()
            .map(|d| (d.id.clone(), d.name.clone()))
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn library_loads_with_unique_ids() {
        let mut ids: Vec<&str> = LIBRARY.iter().map(|d| d.id.as_str()).collect();
        let total = ids.len();
        ids.sort();
        ids.dedup();
        assert!(total >= 30);
        assert_eq!(ids.len(), total);
    }

    #[test]
    fn avoids_recent_directions() {
        let recent: Vec<String> = LIBRARY.iter().take(20).map(|d| d.id.clone()).collect();
        for _ in 0..50 {
            let pick = pick(&recent);
            assert_eq!(pick.starting_points.len(), STARTING_POINTS);
            assert!(
                pick.starting_points
                    .iter()
                    .all(|(id, _)| !recent.contains(id))
            );
        }
    }

    #[test]
    fn falls_back_when_everything_is_recent() {
        let recent: Vec<String> = LIBRARY.iter().map(|d| d.id.clone()).collect();
        assert_eq!(pick(&recent).starting_points.len(), STARTING_POINTS);
    }

    #[test]
    fn varies_between_requests() {
        let first: Vec<_> = (0..10)
            .map(|_| pick(&[]).starting_points[0].0.clone())
            .collect();
        assert!(first.iter().any(|id| id != &first[0]));
    }
}
