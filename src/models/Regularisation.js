module.exports = (sequelize, DataTypes) => {
  const Regularisation = sequelize.define(
    'Regularisation',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      org_id: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      emp_id: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      attendance_id: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      date: { type: DataTypes.DATEONLY, allowNull: false },
      requested_check_in: DataTypes.DATE,
      requested_check_out: DataTypes.DATE,
      evidence_type: {
        type: DataTypes.ENUM('email', 'photo', 'document', 'other'),
        allowNull: false,
      },
      evidence_url: DataTypes.STRING,
      reason: {
        type: DataTypes.TEXT,
        allowNull: false,
      },
      status: {
        type: DataTypes.ENUM('pending', 'manager_approved', 'approved', 'rejected'),
        defaultValue: 'pending',
      },
      manager_approved_by: DataTypes.UUID,
      manager_approved_at: DataTypes.DATE,
      final_approved_by: DataTypes.UUID,
      final_approved_at: DataTypes.DATE,
      rejection_reason: DataTypes.TEXT,
      is_manual: { type: DataTypes.BOOLEAN, defaultValue: false },
    },
    {
      tableName: 'regularisations',
      paranoid: true,
      underscored: true,
    }
  );

  Regularisation.associate = (models) => {
    Regularisation.belongsTo(models.Organisation, { foreignKey: 'org_id', as: 'organisation' });
    Regularisation.belongsTo(models.Employee, { foreignKey: 'emp_id', as: 'employee' });
    Regularisation.belongsTo(models.Attendance, { foreignKey: 'attendance_id', as: 'attendance' });
    Regularisation.belongsTo(models.Employee, { foreignKey: 'manager_approved_by', as: 'manager' });
    Regularisation.belongsTo(models.Employee, { foreignKey: 'final_approved_by', as: 'approver' });
  };

  return Regularisation;
};
