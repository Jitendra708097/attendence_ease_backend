function validateEmployeePayload(body = {}, isUpdate = false) {
  const details = [];
  const requiredFields = ['name', 'email', 'branchId', 'shiftId'];

  requiredFields.forEach((field) => {
    if (!isUpdate && !body[field]) {
      details.push({ field, message: `${field} is required` });
    }
  });

  if (!isUpdate && !body.designationId && !body.designationName) {
    details.push({ field: 'designation', message: 'designation is required' });
  }

  return details;
}

module.exports = {
  validateEmployeePayload,
};
