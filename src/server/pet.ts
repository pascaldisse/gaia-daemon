// Compatibility re-export for the HTTP surface and existing callers. Package
// validation is domain logic shared with /pet, not reimplemented by the server.
export {
  DEFAULT_PET_NAME,
  codexPetsRoot,
  isValidPetPackageName,
  loadPet,
  type LoadedPet,
  type PetManifest,
} from "../domain/pets.js";
